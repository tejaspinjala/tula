import { Hono } from 'hono'
import { z } from 'zod'
import type { Db } from './db/client'
import type { Clock } from './ports/clock'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
}

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

  // The caller's guild comes from `x-guild-id` until authentication lands; a guild that is not
  // the caller's is indistinguishable from one that does not exist.
  app.get('/guilds/:id', async (c) => {
    const caller = uuid.safeParse(c.req.header('x-guild-id'))
    const id = uuid.safeParse(c.req.param('id'))
    if (!caller.success || !id.success) {
      return c.json({ error: 'not_found' }, 404)
    }
    const rows = await deps.db.withGuild(
      caller.data,
      (tx) => tx`select guild_id, name, goal from guilds where guild_id = ${id.data}`
    )
    const row = rows[0]
    if (!row) {
      return c.json({ error: 'not_found' }, 404)
    }
    return c.json({ id: row.guild_id, name: row.name, goal: row.goal })
  })
  return app
}
