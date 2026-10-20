import { type Context, Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import type { Db } from './db/client'
import { createEventHub } from './event-hub'
import { headSeq } from './events'
import type { Clock } from './ports/clock'
import type { ObjectStore } from './ports/object-store'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
  objectStore: ObjectStore
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
  /** Milliseconds between fallback polls for missed notifications; defaults to 5000. */
  eventPollMs?: number
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
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024

/** Builds the guildd HTTP app over the given adapters. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
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
    return c.json({ id: await deps.db.foundGuild(body.data) }, 201)
  })

  /**
   * The single trust boundary: which guild is calling. Until authentication lands (#11) this is
   * the `x-guild-id` header, honoured only when DEV_GUILD_HEADER is on; otherwise no caller.
   */
  function callerGuild(c: Context): string | null {
    if (!deps.devGuildHeader) {
      return null
    }
    const parsed = uuid.safeParse(c.req.header('x-guild-id'))
    return parsed.success ? parsed.data : null
  }

  // A guild that is not the caller's is indistinguishable from one that does not exist.
  app.get('/guilds/:id', async (c) => {
    const caller = callerGuild(c)
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

  // Artifacts: the bytes live in the ObjectStore under the caller's guild namespace; the row
  // records hash, size and class. Idempotent: the same bytes again change nothing.
  app.on(['PUT', 'POST'], '/artifacts', async (c) => {
    const caller = callerGuild(c)
    if (!caller) {
      return c.json({ error: 'unauthenticated' }, 401)
    }
    const cls = artifactClass.safeParse(c.req.query('class'))
    if (!cls.success) {
      return c.json({ error: 'invalid_class' }, 400)
    }
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > MAX_ARTIFACT_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer())
    if (bytes.byteLength > MAX_ARTIFACT_BYTES) {
      return c.json({ error: 'too_large' }, 413)
    }
    const hash = await deps.objectStore.put(caller, bytes)
    const stored = await deps.db.withGuild(caller, async (tx) => {
      await tx`
        insert into artifacts (guild_id, hash, size, class)
        values (${caller}, ${hash}, ${bytes.byteLength}, ${cls.data})
        on conflict (guild_id, hash) do nothing`
      const [row] =
        await tx`select class from artifacts where guild_id = ${caller} and hash = ${hash}`
      return String(row?.class)
    })
    return c.json({ hash, size: bytes.byteLength, class: stored }, 201)
  })

  // An artifact that is not the caller's is indistinguishable from one that does not exist.
  app.get('/artifacts/:hash', async (c) => {
    const caller = callerGuild(c)
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
    const bytes = rows[0] ? await deps.objectStore.get(caller, hash.data) : null
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
      const caller = callerGuild(c)
      if (!caller) {
        return c.json({ error: 'unauthenticated' }, 401)
      }
      if (c.req.param('id') !== caller) {
        return c.json({ error: 'not_found' }, 404)
      }
      if (!hub.hasRoom(caller)) {
        return c.json({ error: 'too_many_streams' }, 429)
      }
      await next()
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
      return {
        onOpen: (_evt, ws) => {
          subscription = hub.subscribe(guild, cursor, {
            send: (data) => ws.send(data),
            bufferedAmount: () =>
              (ws.raw as { getBufferedAmount?: () => number })?.getBufferedAmount?.() ?? 0,
            close: (code, reason) => ws.close(code, reason),
          })
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
