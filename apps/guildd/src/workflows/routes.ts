import type { Context, Hono } from 'hono'
import { z } from 'zod'
import { MAX_WORKFLOW_PAGE } from '../ports/workflow-store'
import { checkSensitive } from '../sensitive'
import { isGuildMaster } from '../treasury'
import type { RunError, WorkflowEngine } from './engine'
import { workflowId } from './graph'

/** What the routes need from the app: the engine, the identity port and the app's session guards. */
export interface WorkflowRouteDeps {
  workflows: WorkflowEngine
  identity: {
    resolveSession(sessionToken: string): Promise<{ guildId: string; role: string } | null>
    consumeReauth(sessionToken: string, proof: string): Promise<boolean>
  }
  /** The calling session when it belongs to `:id`, else a ready response (401/404). */
  sessionGuildFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
  /** {@link sessionGuildFor}, then only the Guild Master passes (403 otherwise). */
  guildMasterSessionFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
}

const limit = z.coerce.number().int().min(1).max(MAX_WORKFLOW_PAGE).default(50)
const idPage = z.object({ after: z.string().max(64).optional(), limit })
const versionPage = z.object({
  before: z.coerce.number().int().min(1).max(2_147_483_647).optional(),
  limit,
})
const versionNumber = z.coerce.number().int().min(1).max(2_147_483_647)
const saveBody = z.object({ name: z.string().trim().min(1).max(200), graph: z.unknown() })
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
  invalid_workflow: 422,
  unknown_template: 422,
  hall_locked: 422,
  hall_paused: 422,
  hall_not_found: 422,
  unknown_owner: 422,
  unknown_blocker: 422,
}

/**
 * Mounts the Workflow routes under `/guilds/:id/workflows`. All are session-guarded; saving,
 * validating a save, confirming and running need the Guild Master, and confirming a widening
 * version needs a fresh re-authentication. The engine has no authority of its own, so a run is
 * only Quests posted through the normal checks.
 */
export function mountWorkflowRoutes(app: Hono, deps: WorkflowRouteDeps): void {
  const base = '/guilds/:id/workflows'
  const notFound = (c: Context) => c.json({ error: 'not_found' }, 404)
  const wid = (c: Context) => {
    const parsed = workflowId.safeParse(c.req.param('wid'))
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
      await deps.workflows.seedTemplates(who.guild)
    }
    return c.json(
      await deps.workflows.list(who.guild, {
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
    const found = id ? await deps.workflows.get(who.guild, id) : null
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
      await deps.workflows.versions(who.guild, id, {
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
    const errors = await deps.workflows.validate(who.guild, body.data.graph)
    return c.json({ valid: errors.length === 0, errors })
  })

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
    const result = await deps.workflows.save(who.guild, id, body.data)
    if (result.status === 'invalid') {
      return c.json({ error: 'invalid_workflow', errors: result.errors }, 422)
    }
    return c.json(result, result.status === 'pending' ? 202 : 200)
  })

  app.post(`${base}/:wid/versions/:version/confirm`, async (c) => {
    const check = await checkSensitive(deps.identity, c.req.raw.headers)
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    if (!isGuildMaster(check.principal)) {
      return c.json({ error: 'forbidden' }, 403)
    }
    const id = wid(c)
    const version = versionNumber.safeParse(c.req.param('version'))
    if (c.req.param('id') !== check.guildId || !id || !version.success) {
      return notFound(c)
    }
    const found = await deps.workflows.get(check.guildId, id, version.data)
    if (!found) {
      return notFound(c)
    }
    if (found.version.status !== 'pending') {
      return c.json({ error: 'not_pending' }, 409)
    }
    await deps.workflows.confirm(check.guildId, id, version.data)
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
    const result = await deps.workflows.run(who.guild, id, {
      ...(body.data.version === undefined ? {} : { version: body.data.version }),
      ...(body.data.runKey === undefined ? {} : { runKey: body.data.runKey }),
    })
    if (!result.ok) {
      return c.json(
        { error: result.error, nodeId: result.nodeId, errors: result.errors },
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
      await deps.workflows.runs(who.guild, id, {
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
    const state = rid.success ? await deps.workflows.state(who.guild, rid.data) : null
    return state && state.instance.workflowId === c.req.param('wid') ? c.json(state) : notFound(c)
  })
}
