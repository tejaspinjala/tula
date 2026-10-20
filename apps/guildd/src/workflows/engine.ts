import type { ConfigStore } from '../ports/config-store'
import type { QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'
import type { TripwireStore } from '../ports/tripwire-store'
import type { WorkflowInstance, WorkflowStore, WorkflowVersion } from '../ports/workflow-store'
import type { ProposalEngine } from '../proposals'
import type { PostQuestError } from '../quests'
import type { WorkflowError } from './graph'

/** Collaborators of {@link WorkflowEngine}. The engine holds no authority of its own. */
export interface WorkflowEngineDeps {
  store: WorkflowStore
  config: Pick<ConfigStore, 'current'>
  quests: QuestQueue
  tripwires: TripwireStore
  proposals: Pick<ProposalEngine, 'latestForQuest' | 'verdictFor'>
  seals: Pick<SealStore, 'forQuest'>
}

/** The outcome of {@link WorkflowEngine.save}. */
export type SaveResult =
  | { status: 'invalid'; errors: WorkflowError[] }
  | { status: 'active' | 'pending'; version: WorkflowVersion }

/** Why a run could not start or finish compiling. */
export type RunError =
  | 'not_found'
  | 'no_active_version'
  | 'version_not_active'
  | 'no_manual_trigger'
  | 'invalid_workflow'
  | PostQuestError

/** The outcome of {@link WorkflowEngine.run}. */
export type RunResult =
  | {
      ok: true
      instance: WorkflowInstance
      created: boolean
      quests: { nodeId: string; questId: string }[]
    }
  | { ok: false; error: RunError; nodeId?: string; errors?: WorkflowError[] }

/** One node's status in a run. */
export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_seal'
  | 'done'
  | 'failed'
  | 'passed'
  | 'awaiting'
  | 'approved'
  | 'rejected'
  | 'publishing'

/** The state of one instance: its nodes and their statuses. */
export interface RunState {
  instance: WorkflowInstance
  nodes: { id: string; type: string; status: NodeStatus; questId: string | null }[]
}

/**
 * The workflow engine: validates and versions graphs, and compiles an instance's `agent` nodes to
 * Quests through the normal queue. It has no authority of its own: Verdicts, Seals, caps and the
 * bar are enforced by the same code paths as for any Quest.
 */
export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  /** Dry-run validation against the guild's current config. */
  async validate(_guildId: string, _graph: unknown): Promise<WorkflowError[]> {
    throw new Error(`not implemented ${typeof this.deps}`)
  }

  /** Saves the next version: invalid graphs are refused, widening ones wait for confirmation. */
  async save(
    _guildId: string,
    _workflowId: string,
    _input: { name: string; graph: unknown }
  ): Promise<SaveResult> {
    throw new Error('not implemented')
  }

  /** Confirms a pending version; null when absent. */
  async confirm(
    _guildId: string,
    _workflowId: string,
    _version: number
  ): Promise<WorkflowVersion | null> {
    throw new Error('not implemented')
  }

  /** Starts (or resumes, for the same `runKey`) an instance of an active version. */
  async run(
    _guildId: string,
    _workflowId: string,
    _opts: { version?: number; runKey?: string }
  ): Promise<RunResult> {
    throw new Error('not implemented')
  }

  /** Per-node status of an instance, or null when absent. */
  async state(_guildId: string, _instanceId: string): Promise<RunState | null> {
    throw new Error('not implemented')
  }

  /** Saves the seeded templates as active versions, once per guild. */
  async seedTemplates(_guildId: string): Promise<void> {
    throw new Error('not implemented')
  }
}
