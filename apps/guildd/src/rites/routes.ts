import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { MAX_RITE_PAGE } from '../ports/rite-store'
import { checkSensitive } from '../sensitive'
import { sessionHeaders } from '../session-cookie'
import { isGuildMaster } from '../treasury'
import type { RiteEngine, RunError } from './engine'
import { riteId } from './graph'

/** What the routes need from the app: the engine, the identity port and the app's session guards. */
export interface RiteRouteDeps {
  rites: RiteEngine
  identity: {
    resolveSession(sessionToken: string): Promise<{ guildId: string; role: string } | null>
    consumeReauth(sessionToken: string, proof: string): Promise<boolean>
  }
  /** The calling session when it belongs to `:id`, else a ready response (401/404). */
  sessionGuildFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
  /** {@link sessionGuildFor}, then only the Guild Master passes (403 otherwise). */
  guildMasterSessionFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
}

const limit = z.coerce.number().int().min(1).max(MAX_RITE_PAGE).default(50)
const idPage = z.object({ after: z.string().max(64).optional(), limit })
const versionPage = z.object({
  before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  limit,
})
const versionNumber = z.coerce.number().int().min(1).max(2_147_483_647)
const saveBody = z.object({ name: z.string().trim().min(1).max(200), graph: z.unknown() })
const publishBody = z.object({ basedOn: versionNumber.nullable() })
const validateBody = z.object({ graph: z.unknown() })
const runBody = z.object({
  version: versionNumber.optional(),
  runKey: z.string().trim().min(1).max(200).optional(),
})

const RUN_STATUS: Record<RunError, 404 | 409 | 422> = {
  not_found: 404,
  no_active_version: 409,
  version_not_active: 409,
  no_manual_trigger: 422,
  invalid_rite: 422,
  unknown_template: 422,
  hall_locked: 422,
  hall_not_private_eligible: 422,
  hall_paused: 422,
  hall_not_found: 422,
  unknown_owner: 422,
  unknown_blocker: 422,
  no_captain: 422,
}

/**
 * Mounts the Rite routes under `/guilds/:id/rites`. All are session-guarded; saving,
 * validating a save, confirming and running need the Guild Master, and confirming a widening
 * version needs a fresh re-authentication. The engine has no authority of its own, so a run is
 * only Quests posted through the normal checks.
 */
export function mountRiteRoutes(app: Hono, deps: RiteRouteDeps): void {
  const base = '/guilds/:id/rites'
  const notFound = (c: Context) => c.json({ error: 'not_found' }, 404)
  const wid = (c: Context) => {
    const parsed = riteId.safeParse(c.req.param('wid'))
    return parsed.success ? parsed.data : null
  }

  app.get(base, async (c) => {
    const who = await deps.sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const page = idPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    if (page.data.after === undefined) {
      await deps.rites.seedTemplates(who.guild)
    }
    return c.json(
      await deps.rites.list(who.guild, {
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  app.get(`${base}/:wid`, async (c) => {
    const who = await deps.sessionGuildFor(c)
    const id = wid(c)
    if ('res' in who) {
      return who.res
    }
    const found = id ? await deps.rites.get(who.guild, id) : null
    return found ? c.json(found) : notFound(c)
  })

  app.get(`${base}/:wid/versions`, async (c) => {
    const who = await deps.sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const page = versionPage.safeParse({
      before: c.req.query('before'),
      limit: c.req.query('limit'),
    })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    if (!id) {
      return notFound(c)
    }
    return c.json(
      await deps.rites.versions(who.guild, id, {
        limit: page.data.limit,
        ...(page.data.before === undefined ? {} : { before: page.data.before }),
      })
    )
  })

  app.post(`${base}/:wid/validate`, async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const body = validateBody.safeParse(await c.req.json().catch(() => null))
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const errors = await deps.rites.validate(who.guild, body.data.graph)
    return c.json({ valid: errors.length === 0, errors })
  })

  // The save answers `{ status, version: { version, ... } }` (the whole stored version, with its
  // classification), where the config PUT answers `{ version: number, status, change }`: a rite
  // version carries its graph and classification, so the object is returned rather than a number.
  app.put(`${base}/:wid`, async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const body = saveBody.safeParse(await c.req.json().catch(() => null))
    if (!(id && body.success)) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await deps.rites.save(who.guild, id, body.data)
    if (result.status === 'invalid') {
      return c.json({ error: 'invalid_rite', errors: result.errors }, 422)
    }
    return c.json(result)
  })

  app.post(`${base}/:wid/versions/:version/publish`, async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const version = versionNumber.safeParse(c.req.param('version'))
    const body = publishBody.safeParse(await c.req.json().catch(() => null))
    if (!(id && version.success)) {
      return notFound(c)
    }
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await deps.rites.publish(who.guild, id, version.data, body.data.basedOn)
    if (!result.ok) {
      return result.error === 'not_found' ? notFound(c) : c.json({ error: result.error }, 409)
    }
    return c.json(
      { status: result.status, version: result.version },
      result.status === 'pending' ? 202 : 200
    )
  })

  app.post(`${base}/:wid/versions/:version/confirm`, async (c) => {
    // Guild, role and version are checked first: a request that cannot succeed must not spend
    // the one-shot re-authentication proof.
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const version = versionNumber.safeParse(c.req.param('version'))
    if (!id || !version.success) {
      return notFound(c)
    }
    const found = await deps.rites.get(who.guild, id, version.data)
    if (!found) {
      return notFound(c)
    }
    if (found.version.status !== 'pending') {
      return c.json({ error: 'not_pending' }, 409)
    }
    const check = await checkSensitive(deps.identity, sessionHeaders(c))
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (check.guildId !== who.guild || !isGuildMaster(check.principal)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const confirmed = await deps.rites.confirm(who.guild, id, version.data)
    if (!confirmed.ok) {
      return confirmed.error === 'not_found' ? notFound(c) : c.json({ error: 'stale' }, 409)
    }
    return c.json({ version: version.data, status: 'active' })
  })

  app.post(`${base}/:wid/runs`, async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const body = runBody.safeParse(await c.req.json().catch(() => ({})))
    if (!(id && body.success)) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const result = await deps.rites.run(who.guild, id, {
      ...(body.data.version === undefined ? {} : { version: body.data.version }),
      ...(body.data.runKey === undefined ? {} : { runKey: body.data.runKey }),
    })
    if (!result.ok) {
      return c.json(
        {
          error: result.error,
          nodeId: result.nodeId,
          errors: result.errors,
          runKey: result.runKey,
        },
        RUN_STATUS[result.error]
      )
    }
    return c.json({ instance: result.instance, quests: result.quests }, result.created ? 201 : 200)
  })

  app.get(`${base}/:wid/runs`, async (c) => {
    const who = await deps.sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const id = wid(c)
    const page = idPage.safeParse({ after: c.req.query('after'), limit: c.req.query('limit') })
    if (!page.success) {
      return c.json({ error: 'invalid_page' }, 400)
    }
    if (!id) {
      return notFound(c)
    }
    return c.json(
      await deps.rites.runs(who.guild, id, {
        limit: page.data.limit,
        ...(page.data.after === undefined ? {} : { after: page.data.after }),
      })
    )
  })

  app.get(`${base}/:wid/runs/:rid`, async (c) => {
    const who = await deps.sessionGuildFor(c)
    if ('res' in who) {
      return who.res
    }
    const rid = z.uuid().safeParse(c.req.param('rid'))
    const state = rid.success ? await deps.rites.state(who.guild, rid.data) : null
    return state && state.instance.riteId === c.req.param('wid') ? c.json(state) : notFound(c)
  })
}
