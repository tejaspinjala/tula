import { type Context, Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import { verifyChain } from './audit-chain'
import type { Db } from './db/client'
import { createEventHub } from './event-hub'
import { appendEvent, headSeq } from './events'
import { assertFinishBody, registerFinishBody } from './identity-schemas'
import type { Clock } from './ports/clock'
import { IdentityError, type IdentityProvider } from './ports/identity'
import type { KeyProvider } from './ports/key-provider'
import type { ObjectStore } from './ports/object-store'
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
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
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

  app.post('/guilds', async (c) => {
    const body = foundGuildBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_guild' }, 400)
    }
    const id = await deps.db.foundGuildChained(body.data, deps.keys)
    return c.json({ id }, 201)
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
    if (await deps.identity.hasCredentials(guild)) {
      const check = await checkSensitive(deps.identity, c.req.raw.headers)
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      if (check.guildId !== guild) {
        return c.json({ error: 'not_found' }, 404)
      }
    }
    return c.json(await deps.identity.beginRegistration(guild, token ?? undefined))
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
    return c.json(
      await deps.identity.finishRegistration(guild, body.data.challengeId, body.data.response),
      201
    )
  })

  app.post('/guilds/:id/sign-in/begin', async (c) => {
    const guild = await ceremonyGuild(c)
    return guild
      ? c.json(await deps.identity.beginSignIn(guild))
      : c.json({ error: 'not_found' }, 404)
  })

  app.post('/guilds/:id/sign-in/finish', async (c) => {
    const guild = await ceremonyGuild(c)
    const body = assertFinishBody.safeParse(await c.req.json().catch(() => null))
    if (!guild) {
      return c.json({ error: 'not_found' }, 404)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
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
      const caller = await callerGuild(c)
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
