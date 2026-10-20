import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type {
  NewWorkflowVersion,
  WorkflowInstance,
  WorkflowInstancePage,
  WorkflowPage,
  WorkflowStore,
  WorkflowVersion,
  WorkflowVersionPage,
} from '../ports/workflow-store'

/** Postgres {@link WorkflowStore} (stub). */
export class PgWorkflowStore implements WorkflowStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async saveVersion(
    _guildId: string,
    _workflowId: string,
    _input: NewWorkflowVersion
  ): Promise<WorkflowVersion> {
    throw new Error(`not implemented ${typeof this.db} ${typeof this.keys} ${this.clock.now()}`)
  }
  async getVersion(
    _guildId: string,
    _workflowId: string,
    _version?: number
  ): Promise<WorkflowVersion | null> {
    throw new Error('not implemented')
  }
  async latestActive(_guildId: string, _workflowId: string): Promise<WorkflowVersion | null> {
    throw new Error('not implemented')
  }
  async activate(
    _guildId: string,
    _workflowId: string,
    _version: number
  ): Promise<WorkflowVersion | null> {
    throw new Error('not implemented')
  }
  async list(_guildId: string, _page: { after?: string; limit: number }): Promise<WorkflowPage> {
    throw new Error('not implemented')
  }
  async versions(
    _guildId: string,
    _workflowId: string,
    _page: { before?: number; limit: number }
  ): Promise<WorkflowVersionPage> {
    throw new Error('not implemented')
  }
  async createInstance(
    _guildId: string,
    _input: { workflowId: string; version: number; runKey: string }
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    throw new Error('not implemented')
  }
  async getInstance(_guildId: string, _id: string): Promise<WorkflowInstance | null> {
    throw new Error('not implemented')
  }
  async listInstances(
    _guildId: string,
    _workflowId: string,
    _page: { after?: string; limit: number }
  ): Promise<WorkflowInstancePage> {
    throw new Error('not implemented')
  }
}
