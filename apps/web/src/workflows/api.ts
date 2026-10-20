import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'
import type { Fetcher } from '../artifacts'
import type { PasskeyBrowser, Session } from '../passkeys'
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

const todo = (): never => {
  throw new Error('todo')
}

/** Lists the Workflows, following the cursor. */
export async function listWorkflows(_s: Session, _f: Fetcher): Promise<WorkflowSummary[]> {
  return todo()
}

/** Loads one version (the latest unless `version` is given) and the active version number. */
export async function loadWorkflow(
  _s: Session,
  _id: string,
  _f: Fetcher,
  _version?: number
): Promise<{ version: VersionDoc; activeVersion: number | null } | null> {
  return todo()
}

/** Loads the newest versions (one page), graphs included. */
export async function loadVersions(_s: Session, _id: string, _f: Fetcher): Promise<VersionDoc[]> {
  return todo()
}

/** Asks the server to validate a graph; the server is the only authority. */
export async function validateGraph(
  _s: Session,
  _id: string,
  _graph: WorkflowGraph,
  _f: Fetcher
): Promise<WorkflowIssue[]> {
  return todo()
}

/** Saves a graph as the next version through `PUT`; throws {@link WorkflowRejected} when invalid. */
export async function saveWorkflow(
  _s: Session,
  _id: string,
  _body: { name: string; graph: WorkflowGraph },
  _f: Fetcher
): Promise<SaveOutcome> {
  return todo()
}

/** Confirms a pending widening version after a fresh passkey re-authentication. */
export async function confirmWorkflowVersion(
  _s: Session,
  _id: string,
  _version: number,
  _f: Fetcher,
  _b: PasskeyBrowser
): Promise<void> {
  return todo()
}

/** Starts a run with the manual trigger. */
export async function runWorkflow(
  _s: Session,
  _id: string,
  _f: Fetcher,
  _runKey?: string
): Promise<RunOutcome> {
  return todo()
}

/** Loads the newest runs of a Workflow. */
export async function listRuns(_s: Session, _id: string, _f: Fetcher): Promise<RunSummary[]> {
  return todo()
}

/** Loads one run's per-node state. */
export async function loadRunState(
  _s: Session,
  _id: string,
  _runId: string,
  _f: Fetcher
): Promise<RunState | null> {
  return todo()
}
