import type { Clock } from '../ports/clock'
import type {
  NewWorkflowVersion,
  WorkflowInstance,
  WorkflowInstancePage,
  WorkflowPage,
  WorkflowStore,
  WorkflowSummary,
  WorkflowVersion,
  WorkflowVersionPage,
} from '../ports/workflow-store'

interface GuildState {
  /** Versions per workflow id, in version order (index + 1 is the version number). */
  workflows: Map<string, WorkflowVersion[]>
  instances: Map<string, WorkflowInstance>
}

/**
 * Memory adapter for {@link WorkflowStore}: state in this instance only. Every method checks and
 * writes with no await in between, so same-tick saves and runs cannot interleave.
 */
export class MemoryWorkflowStore implements WorkflowStore {
  private readonly guilds = new Map<string, GuildState>()

  constructor(private readonly clock: Clock) {}

  private state(guildId: string): GuildState {
    let s = this.guilds.get(guildId)
    if (!s) {
      s = { workflows: new Map(), instances: new Map() }
      this.guilds.set(guildId, s)
    }
    return s
  }

  async saveVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion> {
    const { workflows } = this.state(guildId)
    const list = workflows.get(workflowId) ?? []
    const saved: WorkflowVersion = {
      ...structuredClone(input),
      workflowId,
      version: list.length + 1,
      createdAt: this.clock.now().toISOString(),
    }
    workflows.set(workflowId, [...list, saved])
    return structuredClone(saved)
  }

  async seedVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion | null> {
    return this.saveVersion(guildId, workflowId, input)
  }

  async getVersion(
    guildId: string,
    workflowId: string,
    version?: number
  ): Promise<WorkflowVersion | null> {
    const list = this.state(guildId).workflows.get(workflowId) ?? []
    const found = version === undefined ? list.at(-1) : list[version - 1]
    return found ? structuredClone(found) : null
  }

  async latestActive(guildId: string, workflowId: string): Promise<WorkflowVersion | null> {
    const list = this.state(guildId).workflows.get(workflowId) ?? []
    const found = list.findLast((v) => v.status === 'active')
    return found ? structuredClone(found) : null
  }

  async activate(
    guildId: string,
    workflowId: string,
    version: number
  ): Promise<WorkflowVersion | null> {
    const list = this.state(guildId).workflows.get(workflowId) ?? []
    const found = list[version - 1]
    if (!found) {
      return null
    }
    found.status = 'active'
    return structuredClone(found)
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<WorkflowPage> {
    const summaries: WorkflowSummary[] = []
    for (const [id, list] of this.state(guildId).workflows) {
      const latest = list.at(-1)
      if (!latest || (page.after !== undefined && id <= page.after)) {
        continue
      }
      summaries.push({
        id,
        name: latest.name,
        latestVersion: latest.version,
        activeVersion: list.findLast((v) => v.status === 'active')?.version ?? null,
        updatedAt: latest.createdAt,
      })
    }
    summaries.sort((a, b) => (a.id < b.id ? -1 : 1))
    const workflows = summaries.slice(0, page.limit)
    const last = workflows.at(-1)
    return { workflows, next: summaries.length > page.limit && last ? last.id : null }
  }

  async versions(
    guildId: string,
    workflowId: string,
    page: { before?: number; limit: number }
  ): Promise<WorkflowVersionPage> {
    const all = [...(this.state(guildId).workflows.get(workflowId) ?? [])]
      .filter((v) => page.before === undefined || v.version < page.before)
      .reverse()
    const versions = all.slice(0, page.limit).map((v) => structuredClone(v))
    const last = versions.at(-1)
    return { versions, next: all.length > page.limit && last ? last.version : null }
  }

  async createInstance(
    guildId: string,
    input: { workflowId: string; version: number; runKey: string }
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const s = this.state(guildId)
    if (!s.workflows.get(input.workflowId)?.[input.version - 1]) {
      throw new Error('workflow version not found')
    }
    for (const existing of s.instances.values()) {
      if (existing.workflowId === input.workflowId && existing.runKey === input.runKey) {
        return { instance: structuredClone(existing), created: false }
      }
    }
    const instance: WorkflowInstance = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: this.clock.now().toISOString(),
    }
    s.instances.set(instance.id, instance)
    return { instance: structuredClone(instance), created: true }
  }

  async getInstance(guildId: string, id: string): Promise<WorkflowInstance | null> {
    const found = this.state(guildId).instances.get(id)
    return found ? structuredClone(found) : null
  }

  async listInstances(
    guildId: string,
    workflowId: string,
    page: { after?: string; limit: number }
  ): Promise<WorkflowInstancePage> {
    const all = [...this.state(guildId).instances.values()]
      .filter((i) => i.workflowId === workflowId && (page.after === undefined || i.id > page.after))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const instances = all.slice(0, page.limit).map((i) => structuredClone(i))
    const last = instances.at(-1)
    return { instances, next: all.length > page.limit && last ? last.id : null }
  }
}
