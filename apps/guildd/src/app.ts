import { type Context, Hono } from 'hono'
import { z } from 'zod'
import type { Db } from './db/client'
import type { Clock } from './ports/clock'
import type { ObjectStore } from './ports/object-store'

/** Adapters the HTTP app depends on; supplied only by the composition root. */
export interface AppDeps {
  clock: Clock
  db: Db
  objectStore: ObjectStore
  /** Whether `x-guild-id` identifies the caller (development only). */
  devGuildHeader: boolean
}

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
  return app
}
