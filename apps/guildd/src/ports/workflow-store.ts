import type { WorkflowChangeKind } from '../workflows/classify'
import type { WorkflowGraph } from '../workflows/graph'

/** Largest page a {@link WorkflowStore} list returns. */
export const MAX_WORKFLOW_PAGE = 100

/** `active` versions may run; a `pending` (widening) version waits for confirmation. */
export type WorkflowVersionStatus = 'active' | 'pending'

/** What a save writes. The version number is assigned by the store. */
export interface NewWorkflowVersion {
  name: string
  graph: WorkflowGraph
  classification: WorkflowChangeKind
  status: WorkflowVersionStatus
}

/** One immutable version of a Workflow (only `status` may move, pending to active). */
export interface WorkflowVersion extends NewWorkflowVersion {
  workflowId: string
  /** 1-based, gap-free per Workflow. */
  version: number
  createdAt: string
}

/** A Workflow as listed: its latest version and the newest one that may run. */
export interface WorkflowSummary {
  id: string
  name: string
  latestVersion: number
  /** The newest `active` version, or null while every version is pending. */
  activeVersion: number | null
  updatedAt: string
}

/** One page of Workflows in id order; `next` is the cursor for the following page. */
export interface WorkflowPage {
  workflows: WorkflowSummary[]
  next: string | null
}

/** One page of versions, newest first; `next` is the last version number returned when more remain. */
export interface WorkflowVersionPage {
  versions: WorkflowVersion[]
  next: number | null
}

/** A run of a pinned Workflow version. Its Quests carry the instance id as their Campaign id. */
export interface WorkflowInstance {
  id: string
  workflowId: string
  version: number
  /** De-duplicates a retried run request: one key, one instance. */
  runKey: string
  createdAt: string
}

/** One page of instances in id order. */
export interface WorkflowInstancePage {
  instances: WorkflowInstance[]
  next: string | null
}

/**
 * Port for versioned Workflows and their instances. Versions are immutable: a save appends the next
 * version, atomically, and only `status` moves (pending to active, idempotently). The store holds
 * no authority; Quests are posted by the engine through the normal queue.
 */
export interface WorkflowStore {
  /** Appends the next version of the Workflow (creating it on the first), numbered without gaps. */
  saveVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion>
  /**
   * Saves version 1 only when the Workflow has no version at all, atomically; returns it, or null
   * when one already exists. Used to seed templates without a check-then-write race.
   */
  seedVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion | null>
  /** The given version, or the latest of any status when `version` is omitted; null when absent. */
  getVersion(guildId: string, workflowId: string, version?: number): Promise<WorkflowVersion | null>
  /** The newest `active` version, or null. */
  latestActive(guildId: string, workflowId: string): Promise<WorkflowVersion | null>
  /** Marks a pending version active; idempotent for an active one; null when absent. */
  activate(guildId: string, workflowId: string, version: number): Promise<WorkflowVersion | null>
  /** Workflows in id order strictly after `after`. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<WorkflowPage>
  /** Versions newest first, strictly below `before`. */
  versions(
    guildId: string,
    workflowId: string,
    page: { before?: number; limit: number }
  ): Promise<WorkflowVersionPage>
  /** Creates the instance, or returns the existing one for the same `runKey` with `created: false`. */
  createInstance(
    guildId: string,
    input: { workflowId: string; version: number; runKey: string }
  ): Promise<{ instance: WorkflowInstance; created: boolean }>
  /** One instance, or null. */
  getInstance(guildId: string, id: string): Promise<WorkflowInstance | null>
  /** Instances of a Workflow in id order strictly after `after`. */
  listInstances(
    guildId: string,
    workflowId: string,
    page: { after?: string; limit: number }
  ): Promise<WorkflowInstancePage>
}
