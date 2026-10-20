import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
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
import { workflowGraph } from '../workflows/graph'

const date = z.date().transform((d) => d.toISOString())
const versionRow = z.object({
  workflow_id: z.string(),
  version: z.number(),
  name: z.string(),
  graph: workflowGraph,
  classification: z.enum(['internal', 'widening']),
  status: z.enum(['active', 'pending']),
  created_at: date,
})
const summaryRow = z.object({
  workflow_id: z.string(),
  name: z.string(),
  latest_version: z.number(),
  active_version: z.number().nullable(),
  updated_at: date,
})
const instanceRow = z.object({
  instance_id: z.string(),
  workflow_id: z.string(),
  version: z.number(),
  run_key: z.string(),
  created_at: date,
})

const VERSION_COLUMNS = 'workflow_id, version, name, graph, classification, status, created_at'
const INSTANCE_COLUMNS = 'instance_id, workflow_id, version, run_key, created_at'

function toVersion(r: z.infer<typeof versionRow>): WorkflowVersion {
  return {
    workflowId: r.workflow_id,
    version: r.version,
    name: r.name,
    graph: r.graph,
    classification: r.classification,
    status: r.status,
    createdAt: r.created_at,
  }
}

function toInstance(r: z.infer<typeof instanceRow>): WorkflowInstance {
  return {
    id: r.instance_id,
    workflowId: r.workflow_id,
    version: r.version,
    runKey: r.run_key,
    createdAt: r.created_at,
  }
}

/**
 * Postgres {@link WorkflowStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild).
 * A save takes a transaction-scoped advisory lock per Workflow so version numbers are gap-free;
 * writes append events (ids and small facts only, never the graph) in the same transaction.
 */
export class PgWorkflowStore implements WorkflowStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async saveVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${workflowId}`}, 0))`
      const [row] = await tx`
        insert into workflow_versions
          (guild_id, workflow_id, version, name, graph, classification, status, created_at)
        select ${guildId}, ${workflowId}, coalesce(max(version), 0) + 1, ${input.name},
          ${JSON.stringify(input.graph)}::text::jsonb, ${input.classification}, ${input.status},
          ${now}
        from workflow_versions where guild_id = ${guildId} and workflow_id = ${workflowId}
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      const saved = toVersion(versionRow.parse(row))
      await appendEvent(tx, this.keys, 'workflow.version_saved', {
        workflowId,
        version: saved.version,
        status: saved.status,
        kind: saved.classification,
      })
      return saved
    })
  }

  async seedVersion(
    guildId: string,
    workflowId: string,
    input: NewWorkflowVersion
  ): Promise<WorkflowVersion | null> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${workflowId}`}, 0))`
      const [row] = await tx`
        insert into workflow_versions
          (guild_id, workflow_id, version, name, graph, classification, status, created_at)
        select ${guildId}, ${workflowId}, 1, ${input.name},
          ${JSON.stringify(input.graph)}::text::jsonb, ${input.classification}, ${input.status},
          ${now}
        where not exists (
          select 1 from workflow_versions where guild_id = ${guildId} and workflow_id = ${workflowId})
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      if (!row) {
        return null
      }
      const saved = toVersion(versionRow.parse(row))
      await appendEvent(tx, this.keys, 'workflow.version_saved', {
        workflowId,
        version: saved.version,
        status: saved.status,
        kind: saved.classification,
      })
      return saved
    })
  }

  async getVersion(
    guildId: string,
    workflowId: string,
    version?: number
  ): Promise<WorkflowVersion | null> {
    const wanted = version ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${workflowId}
          and (${wanted}::int is null or version = ${wanted}::int)
        order by version desc limit 1`
      return row ? toVersion(versionRow.parse(row)) : null
    })
  }

  async latestActive(guildId: string, workflowId: string): Promise<WorkflowVersion | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${workflowId} and status = 'active'
        order by version desc limit 1`
      return row ? toVersion(versionRow.parse(row)) : null
    })
  }

  async activate(
    guildId: string,
    workflowId: string,
    version: number
  ): Promise<WorkflowVersion | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [before] = await tx`
        select status from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${workflowId} and version = ${version}`
      if (!before) {
        return null
      }
      const [row] = await tx`
        update workflow_versions set status = 'active'
        where guild_id = ${guildId} and workflow_id = ${workflowId} and version = ${version}
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      if (z.object({ status: z.string() }).parse(before).status === 'pending') {
        await appendEvent(tx, this.keys, 'workflow.version_confirmed', { workflowId, version })
      }
      return row ? toVersion(versionRow.parse(row)) : null
    })
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<WorkflowPage> {
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select workflow_id,
          (array_agg(name order by version desc))[1] as name,
          max(version)::int as latest_version,
          max(version) filter (where status = 'active')::int as active_version,
          max(created_at) as updated_at
        from workflow_versions
        where guild_id = ${guildId} and (${after}::text is null or workflow_id > ${after}::text)
        group by workflow_id
        order by workflow_id limit ${page.limit + 1}`
      const all = rows.map((r) => {
        const s = summaryRow.parse(r)
        return {
          id: s.workflow_id,
          name: s.name,
          latestVersion: s.latest_version,
          activeVersion: s.active_version,
          updatedAt: s.updated_at,
        }
      })
      const workflows = all.slice(0, page.limit)
      const last = workflows.at(-1)
      return { workflows, next: all.length > page.limit && last ? last.id : null }
    })
  }

  async versions(
    guildId: string,
    workflowId: string,
    page: { before?: number; limit: number }
  ): Promise<WorkflowVersionPage> {
    const before = page.before ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${workflowId}
          and (${before}::int is null or version < ${before}::int)
        order by version desc limit ${page.limit + 1}`
      const all = rows.map((r) => toVersion(versionRow.parse(r)))
      const versions = all.slice(0, page.limit)
      const last = versions.at(-1)
      return { versions, next: all.length > page.limit && last ? last.version : null }
    })
  }

  async createInstance(
    guildId: string,
    input: { workflowId: string; version: number; runKey: string }
  ): Promise<{ instance: WorkflowInstance; created: boolean }> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const [inserted] = await tx`
        insert into workflow_instances (guild_id, workflow_id, version, run_key, created_at)
        values (${guildId}, ${input.workflowId}, ${input.version}, ${input.runKey}, ${now})
        on conflict (guild_id, workflow_id, run_key) do nothing
        returning ${tx.unsafe(INSTANCE_COLUMNS)}`
      if (inserted) {
        const instance = toInstance(instanceRow.parse(inserted))
        await appendEvent(tx, this.keys, 'workflow.run_started', {
          instanceId: instance.id,
          workflowId: instance.workflowId,
          version: instance.version,
        })
        return { instance, created: true }
      }
      const [existing] = await tx`
        select ${tx.unsafe(INSTANCE_COLUMNS)} from workflow_instances
        where guild_id = ${guildId} and workflow_id = ${input.workflowId}
          and run_key = ${input.runKey}`
      return { instance: toInstance(instanceRow.parse(existing)), created: false }
    })
  }

  async getInstance(guildId: string, id: string): Promise<WorkflowInstance | null> {
    if (!z.uuid().safeParse(id).success) {
      return null
    }
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select ${tx.unsafe(INSTANCE_COLUMNS)} from workflow_instances
        where guild_id = ${guildId} and instance_id = ${id}`
      return row ? toInstance(instanceRow.parse(row)) : null
    })
  }

  async listInstances(
    guildId: string,
    workflowId: string,
    page: { after?: string; limit: number }
  ): Promise<WorkflowInstancePage> {
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(INSTANCE_COLUMNS)} from workflow_instances
        where guild_id = ${guildId} and workflow_id = ${workflowId}
          and (${after}::uuid is null or instance_id > ${after}::uuid)
        order by instance_id limit ${page.limit + 1}`
      const all = rows.map((r) => toInstance(instanceRow.parse(r)))
      const instances = all.slice(0, page.limit)
      const last = instances.at(-1)
      return { instances, next: all.length > page.limit && last ? last.id : null }
    })
  }
}
