import { z } from 'zod'
import { type RiteGraph, riteGraph } from '../../../guildd/src/rites/graph'
import type { Fetcher } from '../artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from '../passkeys'
import type { RiteIssue, RunNode } from './overlay'

/** One Rite as listed. */
export interface RiteSummary {
  id: string
  name: string
  latestVersion: number
  activeVersion: number | null
  /** When it was archived, or null while it is live. */
  archivedAt: string | null
}

/** One stored version of a Rite. */
export interface VersionDoc {
  version: number
  name: string
  graph: RiteGraph
  status: 'draft' | 'pending' | 'active' | 'superseded'
  classification: string
  createdAt: string
}

/** What a save or publish reports; a save is a `draft`, `pending` means a widening version awaits the passkey confirm. */
export interface SaveOutcome {
  version: number
  status: 'draft' | 'active' | 'pending'
  classification: string
}

/** Thrown when the server refuses a graph as invalid; `errors` are coded and tied to nodes. */
export class RiteRejected extends Error {
  constructor(readonly errors: RiteIssue[]) {
    super('invalid_rite')
    this.name = 'RiteRejected'
  }
}

/** The outcome of a run request. */
export type RunOutcome =
  | { ok: true; instanceId: string; created: boolean }
  | { ok: false; error: string; nodeId?: string; errors?: RiteIssue[]; runKey?: string }

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
  archivedAt: z.string().nullable().default(null),
})
const listBody = z.object({ rites: z.array(summaryBody), next: z.string().nullable() })
const versionBody = z.object({
  version: z.number(),
  name: z.string(),
  graph: riteGraph,
  status: z.enum(['draft', 'pending', 'active', 'superseded']),
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
  status: z.enum(['draft', 'active', 'pending']),
  version: z.object({ version: z.number(), classification: z.string() }),
})
const rejectedBody = z.object({
  error: z.literal('invalid_rite'),
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
      refs: z.array(z.string()).default([]),
    })
  ),
})

/** Most pages one list will follow, so a misbehaving server cannot loop it. */
const MAX_PAGES = 20

const base = (s: Session) => `/api/guilds/${s.guildId}/rites`
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

/** Lists the live Rites, or only the archived ones, following the cursor. */
export async function listRites(s: Session, f: Fetcher, archived = false): Promise<RiteSummary[]> {
  const all: RiteSummary[] = []
  let after: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const query: string = `limit=50${archived ? '&archived=true' : ''}${after === null ? '' : `&after=${encodeURIComponent(after)}`}`
    const page = await call(f, `${base(s)}?${query}`, { headers: auth(s) }, listBody)
    all.push(...page.rites)
    if (page.next === null) {
      return all
    }
    after = page.next
  }
  throw new Error('too many Rite pages')
}

/** Archives a Rite: it leaves the list and cannot run or publish until unarchived. */
export async function archiveRite(s: Session, id: string, f: Fetcher): Promise<void> {
  await call(
    f,
    `${base(s)}/${id}/archive`,
    { method: 'POST', headers: json(s), body: '{}' },
    z.unknown()
  )
}

/** Unarchives a Rite; it comes back with no version in force, so it must be published again. */
export async function unarchiveRite(s: Session, id: string, f: Fetcher): Promise<void> {
  await call(
    f,
    `${base(s)}/${id}/unarchive`,
    { method: 'POST', headers: json(s), body: '{}' },
    z.unknown()
  )
}

/** Loads one version (the latest unless `version` is given) and the active version number. */
export async function loadRite(
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
  graph: RiteGraph,
  f: Fetcher
): Promise<RiteIssue[]> {
  const body = await call(
    f,
    `${base(s)}/${id}/validate`,
    { method: 'POST', headers: json(s), body: JSON.stringify({ graph }) },
    validateBody
  )
  return body.errors
}

/** Saves a graph as the next version (a draft that never runs) through `PUT`; throws {@link RiteRejected} when invalid. */
export async function saveRite(
  s: Session,
  id: string,
  body: { name: string; graph: RiteGraph },
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
      throw new RiteRejected(rejected.data.errors)
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

/**
 * Publishes a draft over the active version it was based on (null for none). An internal draft
 * goes live (`active`); a widening one is `pending` until {@link confirmRiteVersion}. A moved
 * active version is refused as `stale`.
 */
export async function publishRite(
  s: Session,
  id: string,
  version: number,
  basedOn: number | null,
  f: Fetcher
): Promise<SaveOutcome> {
  const { res, data } = await send(f, `${base(s)}/${id}/versions/${version}/publish`, {
    method: 'POST',
    headers: json(s),
    body: JSON.stringify({ basedOn }),
  })
  if (!res.ok) {
    throw refusal(res.status, data)
  }
  const published = savedBody.parse(data)
  return {
    version: published.version.version,
    status: published.status,
    classification: published.version.classification,
  }
}

/** Confirms a pending widening version after a fresh passkey re-authentication. */
export async function confirmRiteVersion(
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
export async function runRite(
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

/** Loads the newest runs of a Rite. */
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
