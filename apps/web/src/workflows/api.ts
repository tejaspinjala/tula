import { z } from 'zod'
import { type WorkflowGraph, workflowGraph } from '../../../guildd/src/workflows/graph'
import type { Fetcher } from '../artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from '../passkeys'
import type { RunNode, WorkflowIssue } from './overlay'

/** One Workflow as listed. */
export interface WorkflowSummary {
  id: string
  name: string
  latestVersion: number
  activeVersion: number | null
}

/** One stored version of a Workflow. */
export interface VersionDoc {
  version: number
  name: string
  graph: WorkflowGraph
  status: 'active' | 'pending'
  classification: string
  createdAt: string
}

/** What a save reports; `pending` means a widening version awaits the passkey confirm. */
export interface SaveOutcome {
  version: number
  status: 'active' | 'pending'
  classification: string
}

/** Thrown when the server refuses a graph as invalid; `errors` are coded and tied to nodes. */
export class WorkflowRejected extends Error {
  constructor(readonly errors: WorkflowIssue[]) {
    super('invalid_workflow')
    this.name = 'WorkflowRejected'
  }
}

/** The outcome of a run request. */
export type RunOutcome =
  | { ok: true; instanceId: string; created: boolean }
  | { ok: false; error: string; nodeId?: string; errors?: WorkflowIssue[]; runKey?: string }

/** A run as listed. */
export interface RunSummary {
  id: string
  version: number
  createdAt: string
}

/** The state of one run. */
export interface RunState {
  instance: RunSummary
  nodes: RunNode[]
}

const summaryBody = z.object({
  id: z.string(),
  name: z.string(),
  latestVersion: z.number(),
  activeVersion: z.number().nullable(),
})
const listBody = z.object({ workflows: z.array(summaryBody), next: z.string().nullable() })
const versionBody = z.object({
  version: z.number(),
  name: z.string(),
  graph: workflowGraph,
  status: z.enum(['active', 'pending']),
  classification: z.string(),
  createdAt: z.string(),
})
const loadedBody = z.object({ version: versionBody, activeVersion: z.number().nullable() })
const versionsBody = z.object({ versions: z.array(versionBody) })
const issueBody = z.object({
  code: z.string(),
  nodeId: z.string().optional(),
  message: z.string(),
})
const validateBody = z.object({ valid: z.boolean(), errors: z.array(issueBody) })
const savedBody = z.object({
  status: z.enum(['active', 'pending']),
  version: z.object({ version: z.number(), classification: z.string() }),
})
const rejectedBody = z.object({
  error: z.literal('invalid_workflow'),
  errors: z.array(issueBody),
})
const runOkBody = z.object({ instance: z.object({ id: z.string() }) })
const runFailBody = z.object({
  error: z.string(),
  nodeId: z.string().optional(),
  errors: z.array(issueBody).optional(),
  runKey: z.string().optional(),
})
const runSummary = z.object({ id: z.string(), version: z.number(), createdAt: z.string() })
const runsBody = z.object({ instances: z.array(runSummary) })
const stateBody = z.object({
  instance: runSummary,
  nodes: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      status: z.string(),
      questId: z.string().nullable(),
    })
  ),
})

/** Most pages one list will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

const base = (s: Session) => `/api/guilds/${s.guildId}/workflows`
const auth = (s: Session) => ({ authorization: `Bearer ${s.token}` })
const json = (s: Session) => ({ ...auth(s), 'content-type': 'application/json' })

async function send(fetcher: Fetcher, url: string, init: RequestInit) {
  const res = await fetcher(url, init)
  const data: unknown = await res.json().catch(() => null)
  return { res, data }
}

function refusal(status: number, data: unknown): PasskeyRequestError {
  const code = z.object({ error: z.string() }).safeParse(data)
  return new PasskeyRequestError(status, code.success ? code.data.error : 'unknown')
}

async function call<T>(
  fetcher: Fetcher,
  url: string,
  init: RequestInit,
  schema: z.ZodType<T>
): Promise<T> {
  const { res, data } = await send(fetcher, url, init)
  if (!res.ok) {
    throw refusal(res.status, data)
  }
  return schema.parse(data)
}

/** Lists the Workflows, following the cursor. */
export async function listWorkflows(s: Session, f: Fetcher): Promise<WorkflowSummary[]> {
  const all: WorkflowSummary[] = []
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=50${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
    const page = await call(f, `${base(s)}?${query}`, { headers: auth(s) }, listBody)
    all.push(...page.workflows)
    if (page.next === null) {
      return all
    }
    after = page.next
  }
  throw new Error('too many Workflow pages')
}

/** Loads one version (the latest unless `version` is given) and the active version number. */
export async function loadWorkflow(
  s: Session,
  id: string,
  f: Fetcher,
  version?: number
): Promise<{ version: VersionDoc; activeVersion: number | null } | null> {
  const suffix = version === undefined ? '' : `?version=${version}`
  const { res, data } = await send(f, `${base(s)}/${id}${suffix}`, { headers: auth(s) })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw refusal(res.status, data)
  }
  return loadedBody.parse(data)
}

/** Loads the newest versions (one page), graphs included. */
export async function loadVersions(s: Session, id: string, f: Fetcher): Promise<VersionDoc[]> {
  const body = await call(
    f,
    `${base(s)}/${id}/versions?limit=20`,
    { headers: auth(s) },
    versionsBody
  )
  return body.versions
}

/** Asks the server to validate a graph; the server is the only authority. */
export async function validateGraph(
  s: Session,
  id: string,
  graph: WorkflowGraph,
  f: Fetcher
): Promise<WorkflowIssue[]> {
  const body = await call(
    f,
    `${base(s)}/${id}/validate`,
    { method: 'POST', headers: json(s), body: JSON.stringify({ graph }) },
    validateBody
  )
  return body.errors
}

/** Saves a graph as the next version through `PUT`; throws {@link WorkflowRejected} when invalid. */
export async function saveWorkflow(
  s: Session,
  id: string,
  body: { name: string; graph: WorkflowGraph },
  f: Fetcher
): Promise<SaveOutcome> {
  const { res, data } = await send(f, `${base(s)}/${id}`, {
    method: 'PUT',
    headers: json(s),
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const rejected = rejectedBody.safeParse(data)
    if (rejected.success) {
      throw new WorkflowRejected(rejected.data.errors)
    }
    throw refusal(res.status, data)
  }
  const saved = savedBody.parse(data)
  return {
    version: saved.version.version,
    status: saved.status,
    classification: saved.version.classification,
  }
}

/** Confirms a pending widening version after a fresh passkey re-authentication. */
export async function confirmWorkflowVersion(
  s: Session,
  id: string,
  version: number,
  f: Fetcher,
  b: PasskeyBrowser
): Promise<void> {
  const proof = await reauthenticate(s.token, f, b)
  await call(
    f,
    `${base(s)}/${id}/versions/${version}/confirm`,
    { method: 'POST', headers: { ...auth(s), 'x-reauth-proof': proof } },
    z.unknown()
  )
}

/** Starts a run with the manual trigger. */
export async function runWorkflow(
  s: Session,
  id: string,
  f: Fetcher,
  runKey?: string
): Promise<RunOutcome> {
  const { res, data } = await send(f, `${base(s)}/${id}/runs`, {
    method: 'POST',
    headers: json(s),
    body: JSON.stringify(runKey === undefined ? {} : { runKey }),
  })
  if (res.ok) {
    return { ok: true, instanceId: runOkBody.parse(data).instance.id, created: res.status === 201 }
  }
  const failed = runFailBody.safeParse(data)
  if (!failed.success) {
    throw refusal(res.status, data)
  }
  const { error, nodeId, errors, runKey: key } = failed.data
  return {
    ok: false,
    error,
    ...(nodeId === undefined ? {} : { nodeId }),
    ...(errors === undefined ? {} : { errors }),
    ...(key === undefined ? {} : { runKey: key }),
  }
}

/** Loads the newest runs of a Workflow. */
export async function listRuns(s: Session, id: string, f: Fetcher): Promise<RunSummary[]> {
  const body = await call(f, `${base(s)}/${id}/runs?limit=20`, { headers: auth(s) }, runsBody)
  return body.instances
}

/** Loads one run's per-node state. */
export async function loadRunState(
  s: Session,
  id: string,
  runId: string,
  f: Fetcher
): Promise<RunState | null> {
  const { res, data } = await send(f, `${base(s)}/${id}/runs/${runId}`, { headers: auth(s) })
  if (res.status === 404) {
    return null
  }
  if (!res.ok) {
    throw refusal(res.status, data)
  }
  return stateBody.parse(data)
}
