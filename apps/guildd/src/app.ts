import { type Context, Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import type { Db } from './db/client'
import { eventsAfter, headSeq } from './events'
import type { Clock } from './ports/clock'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
  /** Milliseconds between event-log polls per live socket; defaults to 200. */
  eventPollMs?: number
}

const { upgradeWebSocket, websocket } = createBunWebSocket()

/** The Bun websocket handler; pass it to `Bun.serve` next to the app's `fetch`. */
export { websocket }

const foundGuildBody = z.object({
  name: z.string().trim().min(1).max(200),
  goal: z.string().trim().min(1).max(2000),
})

const uuid = z.uuid()

/** Builds the guildd HTTP app over the given adapters. */
export function createApp(deps: AppDeps): Hono {
  const app = new Hono()
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
      await next()
    },
    upgradeWebSocket((c) => {
      const guild = c.req.param('id') ?? ''
      const parsed = z.coerce
        .number()
        .int()
        .min(0)
        .safeParse(c.req.query('last_seq') ?? '0')
      let cursor = parsed.success ? parsed.data : 0
      let open = true
      let timer: ReturnType<typeof setTimeout> | undefined
      return {
        onOpen: (_evt, ws) => {
          const pump = async () => {
            try {
              while (open) {
                const batch = await deps.db.withGuild(guild, (tx) => eventsAfter(tx, cursor, 100))
                for (const event of batch) {
                  ws.send(JSON.stringify({ type: 'event', event }))
                  cursor = event.seq
                }
                if (batch.length < 100) {
                  break
                }
              }
            } catch {
              ws.close(1011, 'event stream failed')
              return
            }
            if (open) {
              timer = setTimeout(pump, deps.eventPollMs ?? 200)
            }
          }
          deps.db
            .withGuild(guild, (tx) => headSeq(tx))
            .then((head) => {
              ws.send(JSON.stringify({ type: 'snapshot', head }))
              return pump()
            })
            .catch(() => ws.close(1011, 'event stream failed'))
        },
        onClose: () => {
          open = false
          clearTimeout(timer)
        },
      }
    }),
    (c) => c.json({ error: 'upgrade_required' }, 426)
  )
  return app
}
