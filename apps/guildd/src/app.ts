import { type Context, Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import { verifyChain } from './audit-chain'
import type { Db } from './db/client'
import { createEventHub } from './event-hub'
import { appendEvent, headSeq } from './events'
import { guildConfig } from './guild-config'
import { assertFinishBody, registerFinishBody } from './identity-schemas'
import type { Clock } from './ports/clock'
import { ConfigError, type ConfigStore, MAX_CONFIG_PAGE } from './ports/config-store'
import { IdentityError, type IdentityProvider } from './ports/identity'
import type { KeyProvider } from './ports/key-provider'
import { MAX_NOTE_PAGE, NoteError, type NoteStore, newNote, noteFields } from './ports/note-store'
import type { ObjectStore } from './ports/object-store'
import { MAX_QUEST_PAGE, type QuestQueue, questState } from './ports/quest-queue'
import type { RateLimiter } from './ports/rate-limiter'
import {
  MAX_SECRET_PAGE,
  SecretExistsError,
  type SecretStore,
  secretRef,
  secretValue,
} from './ports/secret-store'
import { postQuest, postQuestInput } from './quests'
import { DEFAULT_RATE_LIMITS, type RateLimits, rateLimit } from './rate-limits'
import { bearerToken, checkSensitive } from './sensitive'
import { readBufferedAmount } from './ws-support'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
  objectStore: ObjectStore
  identity: IdentityProvider
  /** Custody of the audit chain's MAC key; never the database. */
  keys: KeyProvider
  /** The Vault: envelope-encrypted provider keys; values leave only through internal `resolve`. */
  secrets: SecretStore
  /** Versioned guild config: Halls, roster, Seal Policy, caps; widening changes wait for re-auth. */
  config: ConfigStore
  /** The Archive: notes with version history, backlinks and full-text search. */
  notes: NoteStore
  /** The Quest queue: Quests, leases, retries and the dead-letter list. */
  quests: QuestQueue
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
  /** Abuse limits for the unauthenticated identity routes; state is shared, never in process memory. */
  rateLimiter: RateLimiter
  /** Read the client address from the last `X-Forwarded-For` hop (env `TRUST_PROXY`); default false. */
  trustProxy?: boolean
  /** Per-route limit overrides; defaults to {@link DEFAULT_RATE_LIMITS}. */
  rateLimits?: Partial<RateLimits>
  /** Milliseconds between fallback polls for missed notifications; defaults to 5000. */
  eventPollMs?: number
  /** Milliseconds before an ObjectStore call is abandoned with a 504; defaults to 10000. */
  objectStoreTimeoutMs?: number
  /** Largest accepted artifact in bytes; defaults to {@link MAX_ARTIFACT_BYTES}. */
  maxArtifactBytes?: number
  /** Live event sockets allowed per guild; defaults to 8. */
  maxSocketsPerGuild?: number
  /** A socket buffering more than this many bytes is closed; defaults to 1 MiB. */
  maxSocketBufferBytes?: number
}

const { upgradeWebSocket, websocket } = createBunWebSocket()

/** The Bun websocket handler; pass it to `Bun.serve` next to the app's `fetch`. */
export { websocket }

const foundGuildBody = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(2000),
})

const uuid = z.uuid()
/** Largest accepted request body for adding a secret. */
const MAX_SECRET_REQUEST_BYTES = 16 * 1024
const addSecretBody = z.object({ ref: secretRef, value: secretValue })
const checkSecretsBody = z.object({ refs: z.array(secretRef).min(1).max(MAX_SECRET_PAGE) })
const secretPage = z.object({
  after: secretRef.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_SECRET_PAGE).default(50),
})
const notePage = z.object({
  after: uuid.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_NOTE_PAGE).default(50),
  q: z.string().max(500).optional(),
})
const questPage = z.object({
  after: z
    .string()
    .regex(/^\d{1,15}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(MAX_QUEST_PAGE).default(50),
  state: questState.optional(),
})
const putConfigBody = z.object({ config: guildConfig })
const configVersion = z.coerce.number().int().min(1).max(2_147_483_647)
const versionPage = z.object({
  after: configVersion.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONFIG_PAGE).default(50),
})
const rosterPage = z.object({
  after: z.string().max(64).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONFIG_PAGE).default(50),
})
const artifactClass = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const artifactHash = z.string().regex(/^[0-9a-f]{64}$/)
/** Default artifact size cap; main.ts sizes Bun's request-body limit from it. */
export const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Thrown when an ObjectStore call outlives its timeout. */
class StoreTimeoutError extends Error {}

/** Reads a request body, stopping as soon as it exceeds `limit`; null means over the limit. */
async function readCapped(body: ReadableStream<Uint8Array> | null, limit: number) {
  const chunks: Uint8Array[] = []
  let total = 0
  if (body) {
    const reader = body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) {
        break
      }
      total += value.byteLength
      if (total > limit) {
        await reader.cancel()
        return null
      }
      chunks.push(value)
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/** Builds the guildd HTTP app over the given adapters. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
  // Releases a reserved stream slot once the socket opens; keyed by the upgrade request.
  const streamSlots = new WeakMap<Request, () => void>()
  const maxBytes = deps.maxArtifactBytes ?? MAX_ARTIFACT_BYTES
  const storeTimeoutMs = deps.objectStoreTimeoutMs ?? 10_000

  /** Bounds an ObjectStore call so a stalled backend cannot hold a request open. */
  function withStoreTimeout<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeoutError()), storeTimeoutMs)
    })
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
  }
  app.onError((err, c) => {
    if (err instanceof StoreTimeoutError) {
      return c.json({ error: 'object_store_timeout' }, 504)
    }
    if (err instanceof IdentityError) {
      return c.json({ error: err.code }, err.code === 'invalid_challenge' ? 400 : 401)
    }
    return c.json({ error: 'internal_error' }, 500)
  })
  const hub = createEventHub(deps.db, {
    pollMs: deps.eventPollMs,
    maxSocketsPerGuild: deps.maxSocketsPerGuild,
    maxBufferedBytes: deps.maxSocketBufferBytes,
  })
  app.get('/health', (c) => c.json({ status: 'ok', time: deps.clock.now().toISOString() }))

  // Unauthenticated identity routes are rate limited per client and per guild (429 + Retry-After).
  const limitsOf = { ...DEFAULT_RATE_LIMITS, ...deps.rateLimits }
  const limited = (route: keyof RateLimits) =>
    rateLimit(deps.rateLimiter, route, limitsOf[route], deps.trustProxy ?? false)
  app.post('/guilds', limited('founding'))
  app.post('/guilds/:id/passkeys/begin', limited('passkeys-begin'))
  app.post('/guilds/:id/passkeys/finish', limited('passkeys-finish'))
  app.post('/guilds/:id/sign-in/begin', limited('signin-begin'))
  app.post('/guilds/:id/sign-in/finish', limited('signin-finish'))
  app.post('/session/reauth/begin', limited('reauth'))
  app.post('/session/reauth/finish', limited('reauth'))

  app.post('/guilds', async (c) => {
    const body = foundGuildBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_guild' }, 400)
    }
    // The founding token is issued inside the founding transaction, so a failure leaves no guild.
    // Returned once; only its hash is kept. Needed to register the guild's first passkey.
    let foundingToken = ''
    const id = await deps.db.foundGuildChained(body.data, deps.keys, async (tx, guildId) => {
      foundingToken = (await deps.identity.issueFoundingToken(guildId, tx)).token
      // The Steward, Heralds Hall and locked Halls are seeded in the founding transaction.
      await deps.config.seed(guildId, tx)
    })
    return c.json({ id, foundingToken }, 201)
  })

  /**
   * The single trust boundary: which guild is calling. A Bearer session token (passkey sign-in)
   * names the guild; otherwise it is the `x-guild-id` header, honoured only when DEV_GUILD_HEADER is on; otherwise no caller.
   */
  async function callerGuild(c: Context): Promise<string | null> {
    const token = bearerToken(c.req.header('authorization'))
    if (token) {
      return (await deps.identity.resolveSession(token))?.guildId ?? null
    }
    if (!deps.devGuildHeader) {
      return null
    }
    const parsed = uuid.safeParse(c.req.header('x-guild-id'))
    return parsed.success ? parsed.data : null
  }

  /**
   * The caller of a WebSocket upgrade from a browser, which cannot set an Authorization header:
   * the session token may come as `?access_token=`. Used only by the event stream.
   */
  async function queryTokenGuild(c: Context): Promise<string | null> {
    const token = c.req.query('access_token')
    return token ? ((await deps.identity.resolveSession(token))?.guildId ?? null) : null
  }

  /** Whether the guild exists (the guild row is visible only under its own tenant context). */
  async function guildExists(id: string): Promise<boolean> {
    const rows = await deps.db.withGuild(
      id,
      (tx) => tx`select 1 from guilds where guild_id = ${id}`
    )
    return rows.length > 0
  }

  /** Parses `:id` as a guild that exists, else null (caller answers 404). */
  async function ceremonyGuild(c: Context): Promise<string | null> {
    const id = uuid.safeParse(c.req.param('id'))
    return id.success && (await guildExists(id.data)) ? id.data : null
  }

  // Passkeys. The first passkey of a guild is open (founding); adding another is a sensitive
  // action: a session of that guild plus a fresh re-authentication proof.
  app.post('/guilds/:id/passkeys/begin', async (c) => {
    const guild = await ceremonyGuild(c)
    if (!guild) {
      return c.json({ error: 'not_found' }, 404)
    }
    const token = bearerToken(c.req.header('authorization'))
    const foundingToken = c.req.header('x-founding-token')
    if (await deps.identity.hasCredentials(guild)) {
      const check = await checkSensitive(deps.identity, c.req.raw.headers)
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      if (check.guildId !== guild) {
        return c.json({ error: 'not_found' }, 404)
      }
    }
    return c.json(
      await deps.identity.beginRegistration(guild, {
        ...(token ? { sessionToken: token } : {}),
        ...(foundingToken ? { foundingToken } : {}),
      })
    )
  })

  app.post('/guilds/:id/passkeys/finish', async (c) => {
    const guild = await ceremonyGuild(c)
    const body = registerFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!guild) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const sessionToken = bearerToken(c.req.header('authorization'))
    return c.json(
      await deps.identity.finishRegistration(
        guild,
        body.data.challengeId,
        body.data.response,
        sessionToken ? { sessionToken } : {}
      ),
      201
    )
  })

  // Unknown guilds get decoy options from the provider, so this answers the same for every id.
  app.post('/guilds/:id/sign-in/begin', async (c) => {
    return c.json(await deps.identity.beginSignIn(c.req.param('id')))
  })

  app.post('/guilds/:id/sign-in/finish', async (c) => {
    const guild = await ceremonyGuild(c)
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    if (!guild) {
      // Same answer as a known guild given a challenge it never issued.
      return c.json({ error: 'invalid_challenge' }, 400)
    }
    const session = await deps.identity.finishSignIn(
      guild,
      body.data.challengeId,
      body.data.response
    )
    return c.json(session)
  })

  app.post('/session/reauth/begin', async (c) => {
    const token = bearerToken(c.req.header('authorization'))
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    return c.json(await deps.identity.beginReauth(token))
  })

  app.post('/session/reauth/finish', async (c) => {
    const token = bearerToken(c.req.header('authorization'))
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!token) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json(
      await deps.identity.finishReauth(token, body.data.challengeId, body.data.response)
    )
  })

  // A guild that is not the caller's is indistinguishable from one that does not exist.
  app.get('/guilds/:id', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const id = uuid.safeParse(c.req.param('id'))
    if (!id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const rows = await deps.db.withGuild(
      caller,
      (tx) => tx`select guild_id, name, goal from guilds where guild_id = ${id.data}`
    )
    const row = rows[0]
    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ id: row.guild_id, name: row.name, goal: row.goal })
  })

  // The Vault. Adding a secret is a sensitive action (fresh passkey re-authentication, spent by
  // the check); nothing here ever returns, logs or errors with a secret value.
  app.post('/guilds/:id/vault/secrets', async (c) => {
    const check = await checkSensitive(deps.identity, c.req.raw.headers)
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (c.req.param('id') !== check.guildId) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (Number(c.req.header('content-length') ?? 0) > MAX_SECRET_REQUEST_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    const raw = await readCapped(c.req.raw.body, MAX_SECRET_REQUEST_BYTES)
    if (!raw) {
      return c.json({ error: 'too_large' }, 413)
    }
    const body = addSecretBody.safeParse(
      (() => {
        try {
          return JSON.parse(new TextDecoder().decode(raw))
        } catch {
          return null
        }
      })()
    )
    if (!body.success) {
      return c.json({ error: 'invalid_secret' }, 400)
    }
    try {
      await deps.secrets.add(check.guildId, body.data.ref, body.data.value)
    } catch (error) {
      if (error instanceof SecretExistsError) {
        return c.json({ error: 'secret_exists' }, 409)
      }
      throw error
    }
    return c.json({ ref: body.data.ref }, 201)
  })

  app.get('/guilds/:id/vault/secrets', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = secretPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.secrets.list(caller, {
        limit: page.data.limit,
        ...(page.data.after ? { after: page.data.after } : {}),
      })
    )
  })

  app.post('/guilds/:id/vault/check', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const body = checkSecretsBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    return c.json({ results: await deps.secrets.check(caller, body.data.refs) })
  })

  // The Archive. Note writes are events (appended by the NoteStore in the write's transaction).
  // A guild that is not the caller's is indistinguishable from one that does not exist.
  async function archiveCaller(c: Context): Promise<{ guild: string } | Response> {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    return { guild: caller }
  }

  function noteFailure(c: Context, error: unknown): Response {
    if (error instanceof NoteError) {
      return error.code === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: error.code }, 422)
    }
    throw error
  }

  app.post('/guilds/:id/archive/notes', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const body = newNote.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    try {
      return c.json(await deps.notes.add(who.guild, body.data), 201)
    } catch (error) {
      return noteFailure(c, error)
    }
  })

  app.patch('/guilds/:id/archive/notes/:noteId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const noteId = uuid.safeParse(c.req.param('noteId'))
    const body = noteFields.partial().safeParse(await c.req.json().catch(() => null))
    if (!noteId.success || !body.success) {
      return c.json(
        { error: noteId.success ? 'invalid_request' : 'not_found' },
        noteId.success ? 400 : 404
      )
    }
    try {
      return c.json(await deps.notes.edit(who.guild, noteId.data, body.data))
    } catch (error) {
      return noteFailure(c, error)
    }
  })

  app.get('/guilds/:id/archive/notes/:noteId', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const noteId = uuid.safeParse(c.req.param('noteId'))
    const detail = noteId.success ? await deps.notes.get(who.guild, noteId.data) : null
    return detail ? c.json(detail) : c.json({ error: 'not_found' }, 404)
  })

  // Lists notes, or full-text searches them with `?q=`.
  app.get('/guilds/:id/archive/notes', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = notePage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      q: c.req.query('q'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const paging = {
      limit: page.data.limit,
      ...(page.data.after ? { after: page.data.after } : {}),
    }
    return c.json(
      page.data.q === undefined
        ? await deps.notes.list(who.guild, paging)
        : await deps.notes.search(who.guild, page.data.q, paging)
    )
  })

  // Quests. Posting and every transition is an event appended by the QuestQueue. Like the
  // Archive, a guild that is not the caller's is indistinguishable from one that does not exist.
  app.post('/guilds/:id/quests', async (c) => {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const body = postQuestInput.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await postQuest(
      { config: deps.config, queue: deps.quests },
      who.guild,
      body.data
    )
    if (!result.ok) {
      return c.json({ error: result.error }, 422)
    }
    return c.json(result.quest, result.created ? 201 : 200)
  })

  async function questList(c: Context, dead: boolean): Promise<Response> {
    const who = await archiveCaller(c)
    if (who instanceof Response) {
      return who
    }
    const page = questPage.safeParse({
      after: c.req.query('after'),
      limit: c.req.query('limit'),
      state: c.req.query('state'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    const paging = {
      limit: page.data.limit,
      ...(page.data.after ? { after: page.data.after } : {}),
    }
    return c.json(
      dead
        ? await deps.quests.deadLetters(who.guild, paging)
        : await deps.quests.list(who.guild, {
            ...paging,
            ...(page.data.state ? { state: page.data.state } : {}),
          })
    )
  }

  app.get('/guilds/:id/quests', (c) => questList(c, false))
  app.get('/guilds/:id/quests/dead-letters', (c) => questList(c, true))

  // Guild config. Reads follow `callerGuild`. Writes need a real session: the dev header never
  // writes config, and agents have no session, so no agent-facing route can change it. A widening
  // change is stored pending and only `confirm`, behind re-authentication, puts it in force.
  /** The calling session's guild when it is `:id`, else a ready response. */
  async function sessionGuildFor(c: Context): Promise<{ guild: string } | { res: Response }> {
    const token = bearerToken(c.req.header('authorization'))
    const session = token ? await deps.identity.resolveSession(token) : null
    if (!session) {
      return { res: c.json({ error: 'unauthenticated' }, 401) }
    }
    if (c.req.param('id') !== session.guildId) {
      return { res: c.json({ error: 'not_found' }, 404) }
    }
    return { guild: session.guildId }
  }

  function configFailure(c: Context, error: unknown): Response {
    if (error instanceof ConfigError) {
      return error.code === 'not_found'
        ? c.json({ error: 'not_found' }, 404)
        : c.json({ error: error.code }, 409)
    }
    throw error
  }

  app.get('/guilds/:id/config', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      return c.json(await deps.config.current(caller))
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.get('/guilds/:id/config/versions', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = versionPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    return c.json(
      await deps.config.history(caller, {
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  // The ledger view's roster: the Steward plus Halls (with Captain and Members), paginated by Hall id.
  app.get('/guilds/:id/roster', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    const page = rosterPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    try {
      const { config } = await deps.config.current(caller)
      const halls = config.halls
        .filter((h) => page.data.after === undefined || h.id > page.data.after)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const items = halls.slice(0, page.data.limit)
      const last = items.at(-1)
      return c.json({
        steward: config.steward,
        halls: items,
        next: halls.length > page.data.limit && last ? last.id : null,
      })
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.put('/guilds/:id/config', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = putConfigBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_config' }, 400)
    }
    try {
      const result = await deps.config.propose(who.guild, body.data.config)
      return c.json(result, result.status === 'pending' ? 202 : 200)
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.post('/guilds/:id/config/versions/:version/restore', async (c) => {
    const who = await sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const version = configVersion.safeParse(c.req.param('version'))
    if (!version.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      const result = await deps.config.restore(who.guild, version.data)
      return c.json(result, result.status === 'pending' ? 202 : 200)
    } catch (error) {
      return configFailure(c, error)
    }
  })

  app.post('/guilds/:id/config/versions/:version/confirm', async (c) => {
    const check = await checkSensitive(deps.identity, c.req.raw.headers)
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    const version = configVersion.safeParse(c.req.param('version'))
    if (c.req.param('id') !== check.guildId || !version.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    try {
      await deps.config.confirm(check.guildId, version.data)
      return c.json({ version: version.data, status: 'applied' })
    } catch (error) {
      return configFailure(c, error)
    }
  })

  // Audit verification: replays the guild's chain with the KeyProvider's key. A guild that is not
  // the caller's is indistinguishable from one that does not exist.
  app.get('/guilds/:id/audit/verify', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    if (c.req.param('id') !== caller) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json(await deps.db.withGuild(caller, (tx) => verifyChain(tx, deps.keys)))
  })

  // Artifacts: the bytes live in the ObjectStore under the caller's guild namespace; the row
  // records hash, size and class. Idempotent: the same bytes again change nothing.
  app.on(['PUT', 'POST'], '/artifacts', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const cls = artifactClass.safeParse(c.req.query('class'))
    if (!cls.success) {
      return c.json({ error: 'invalid_class' }, 400)
    }
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > maxBytes) {
      return c.json({ error: 'too_large' }, 413)
    }
    const bytes = await readCapped(c.req.raw.body, maxBytes)
    if (!bytes) {
      return c.json({ error: 'too_large' }, 413)
    }
    const hash = await withStoreTimeout(deps.objectStore.put(caller, bytes))
    const stored = await deps.db.withGuild(caller, async (tx) => {
      const inserted = await tx`
        insert into artifacts (guild_id, hash, size, class)
        values (${caller}, ${hash}, ${bytes.byteLength}, ${cls.data})
        on conflict (guild_id, hash) do nothing
        returning hash`
      if (inserted.length > 0) {
        await appendEvent(tx, deps.keys, 'artifact.stored', {
          hash,
          class: cls.data,
          size: bytes.byteLength,
        })
      }
      const [row] =
        await tx`select class from artifacts where guild_id = ${caller} and hash = ${hash}`
      return String(row?.class)
    })
    return c.json({ hash, size: bytes.byteLength, class: stored }, 201)
  })

  // An artifact that is not the caller's is indistinguishable from one that does not exist.
  app.get('/artifacts/:hash', async (c) => {
    const caller = await callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const hash = artifactHash.safeParse(c.req.param('hash'))
    if (!hash.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const rows = await deps.db.withGuild(
      caller,
      (tx) => tx`select class from artifacts where guild_id = ${caller} and hash = ${hash.data}`
    )
    const bytes = rows[0] ? await withStoreTimeout(deps.objectStore.get(caller, hash.data)) : null
    if (!rows[0] || !bytes) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.body(bytes.slice(), 200, {
      'content-type': 'application/octet-stream',
      'x-artifact-class': String(rows[0].class),
    })
  })

  /**
   * Live event stream. The client sends `?last_seq=N` (the last seq it has applied); the server
   * answers `{type:'snapshot', head}` (the log's head at connect) and then every event with
   * seq > N in order, then new ones as they commit. State lives in Postgres, not in this process:
   * each socket just remembers its own cursor.
   */
  app.get(
    '/guilds/:id/events',
    async (c, next) => {
      const caller = (await callerGuild(c)) ?? (await queryTokenGuild(c))
      if (!caller) {
        return c.json({ error: 'unauthenticated' }, 401)
      }
      if (c.req.param('id') !== caller) {
        return c.json({ error: 'not_found' }, 404)
      }
      // Reserve the slot before upgrading so simultaneous upgrades cannot exceed the cap.
      const slot = hub.reserve(caller)
      if (!slot) {
        return c.json({ error: 'too_many_streams' }, 429)
      }
      streamSlots.set(c.req.raw, slot)
      try {
        await next()
      } catch (error) {
        slot()
        throw error
      }
      if (c.res.status >= 400) {
        slot()
      }
    },
    upgradeWebSocket((c) => {
      const guild = c.req.param('id') ?? ''
      const parsed = z.coerce
        .number()
        .int()
        .min(0)
        .safeParse(c.req.query('last_seq') ?? '0')
      const cursor = parsed.success ? parsed.data : 0
      let subscription: ReturnType<typeof hub.subscribe> | undefined
      const slot = streamSlots.get(c.req.raw)
      return {
        onOpen: (_evt, ws) => {
          subscription = hub.subscribe(guild, cursor, {
            send: (data) => ws.send(data),
            // Unknown buffer size fails closed: treated as over any threshold, so the hub closes it.
            bufferedAmount: () => readBufferedAmount(ws.raw) ?? Number.POSITIVE_INFINITY,
            close: (code, reason) => ws.close(code, reason),
          })
          slot?.()
          const sub = subscription
          deps.db
            .withGuildStream(guild, (tx) => headSeq(tx))
            .then((head) => {
              ws.send(JSON.stringify({ type: 'snapshot', head }))
              sub.start()
            })
            .catch(() => ws.close(1011, 'event stream failed'))
        },
        onClose: () => subscription?.unsubscribe(),
      }
    }),
    (c) => c.json({ error: 'upgrade_required' }, 426)
  )
  return app
}
