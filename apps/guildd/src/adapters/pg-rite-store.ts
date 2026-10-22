import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type {
  ActivateResult,
  ArchiveResult,
  NewRiteVersion,
  PublishDraftResult,
  RitePage,
  RiteRun,
  RiteRunPage,
  RiteStore,
  RiteVersion,
  RiteVersionPage,
  UnarchiveResult,
} from '../ports/rite-store'
import { RITE_EVENT } from '../rites/events'
import { riteGraph } from '../rites/graph'

const date = z.date().transform((d) => d.toISOString())
const versionRow = z.object({
  workflow_id: z.string(),
  version: z.number(),
  name: z.string(),
  graph: riteGraph,
  classification: z.enum(['internal', 'widening']),
  status: z.enum(['draft', 'pending', 'active', 'superseded']),
  based_on: z.number().nullable(),
  created_at: date,
})
const summaryRow = z.object({
  workflow_id: z.string(),
  name: z.string(),
  latest_version: z.number(),
  active_version: z.number().nullable(),
  updated_at: date,
  archived_at: date.nullable(),
})
const instanceRow = z.object({
  instance_id: z.string(),
  workflow_id: z.string(),
  version: z.number(),
  run_key: z.string(),
  created_at: date,
})

const VERSION_COLUMNS =
  'workflow_id, version, name, graph, classification, status, based_on, created_at'
const INSTANCE_COLUMNS = 'instance_id, workflow_id, version, run_key, created_at'

function toVersion(r: z.infer<typeof versionRow>): RiteVersion {
  return {
    riteId: r.workflow_id,
    version: r.version,
    name: r.name,
    graph: r.graph,
    classification: r.classification,
    status: r.status,
    basedOn: r.based_on,
    createdAt: r.created_at,
  }
}

function toInstance(r: z.infer<typeof instanceRow>): RiteRun {
  return {
    id: r.instance_id,
    riteId: r.workflow_id,
    version: r.version,
    runKey: r.run_key,
    createdAt: r.created_at,
  }
}

/**
 * Postgres {@link RiteStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild).
 * A save takes a transaction-scoped advisory lock per Rite so version numbers are gap-free;
 * writes append events (ids and small facts only, never the graph) in the same transaction.
 */
export class PgRiteStore implements RiteStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async saveVersion(guildId: string, riteId: string, input: NewRiteVersion): Promise<RiteVersion> {
    return this.db.withGuild(guildId, (tx) => this.saveVersionIn(tx, guildId, riteId, input))
  }

  /** {@link RiteStore.saveVersion} on a transaction the caller owns, so it commits with other writes. */
  async saveVersionIn(
    tx: TenantTx,
    guildId: string,
    riteId: string,
    input: NewRiteVersion
  ): Promise<RiteVersion> {
    const now = this.clock.now()
    await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
    const [row] = await tx`
      insert into workflow_versions
        (guild_id, workflow_id, version, name, graph, classification, status, created_at)
      select ${guildId}, ${riteId}, coalesce(max(version), 0) + 1, ${input.name},
        ${JSON.stringify(input.graph)}::text::jsonb, ${input.classification}, ${input.status},
        ${now}
      from workflow_versions where guild_id = ${guildId} and workflow_id = ${riteId}
      returning ${tx.unsafe(VERSION_COLUMNS)}`
    const saved = toVersion(versionRow.parse(row))
    await appendEvent(tx, this.keys, RITE_EVENT.versionSaved, {
      riteId,
      version: saved.version,
      status: saved.status,
      kind: saved.classification,
    })
    return saved
  }

  async seedVersion(
    guildId: string,
    riteId: string,
    input: NewRiteVersion
  ): Promise<RiteVersion | null> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
      const [row] = await tx`
        insert into workflow_versions
          (guild_id, workflow_id, version, name, graph, classification, status, created_at)
        select ${guildId}, ${riteId}, 1, ${input.name},
          ${JSON.stringify(input.graph)}::text::jsonb, ${input.classification}, ${input.status},
          ${now}
        where not exists (
          select 1 from workflow_versions where guild_id = ${guildId} and workflow_id = ${riteId})
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      if (!row) {
        return null
      }
      const saved = toVersion(versionRow.parse(row))
      await appendEvent(tx, this.keys, RITE_EVENT.versionSaved, {
        riteId,
        version: saved.version,
        status: saved.status,
        kind: saved.classification,
      })
      return saved
    })
  }

  async getVersion(guildId: string, riteId: string, version?: number): Promise<RiteVersion | null> {
    const wanted = version ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId}
          and (${wanted}::int is null or version = ${wanted}::int)
        order by version desc limit 1`
      return row ? toVersion(versionRow.parse(row)) : null
    })
  }

  async latestActive(guildId: string, riteId: string): Promise<RiteVersion | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and status = 'active'
        order by version desc limit 1`
      return row ? toVersion(versionRow.parse(row)) : null
    })
  }

  async publishDraft(
    guildId: string,
    riteId: string,
    input: {
      version: number
      basedOn: number | null
      classifiedAgainst: number | null
      outcome: 'active' | 'pending'
    }
  ): Promise<PublishDraftResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
      const [found] = await tx`
        select status from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${input.version}`
      if (!found) {
        return { ok: false, error: 'not_found' }
      }
      if (z.object({ status: z.string() }).parse(found).status !== 'draft') {
        return { ok: false, error: 'not_draft' }
      }
      const [current] = await tx`
        select version from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and status = 'active'
        order by version desc limit 1`
      const active = current ? z.object({ version: z.number() }).parse(current).version : null
      if (active !== input.basedOn || active !== input.classifiedAgainst) {
        return { ok: false, error: 'stale' }
      }
      if (input.outcome === 'active' && active !== null) {
        await tx`
          update workflow_versions set status = 'superseded'
          where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${active}`
      }
      const [row] = await tx`
        update workflow_versions
        set status = ${input.outcome}, based_on = ${input.outcome === 'pending' ? active : null}
        where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${input.version}
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      const version = toVersion(versionRow.parse(row))
      await appendEvent(tx, this.keys, RITE_EVENT.versionPublished, {
        riteId,
        version: version.version,
        status: version.status,
        kind: version.classification,
        supersedes: input.outcome === 'active' ? active : null,
      })
      return { ok: true, version }
    })
  }

  async activate(guildId: string, riteId: string, version: number): Promise<ActivateResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
      const [before] = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${version}`
      if (!before) {
        return { ok: false, error: 'not_found' }
      }
      const current = toVersion(versionRow.parse(before))
      if (current.status !== 'pending') {
        return { ok: true, version: current }
      }
      if ((await this.archivedAtIn(tx, guildId, riteId)) !== null) {
        return { ok: false, error: 'rite_archived' }
      }
      const [over] = await tx`
        select based_on from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${version}`
      const [live] = await tx`
        select version from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId} and status = 'active'
        order by version desc limit 1`
      const basedOn = z.object({ based_on: z.number().nullable() }).parse(over).based_on
      const active = live ? z.object({ version: z.number() }).parse(live).version : null
      if (active !== basedOn) {
        return { ok: false, error: 'stale' }
      }
      await tx`
        update workflow_versions set status = 'superseded'
        where guild_id = ${guildId} and workflow_id = ${riteId} and status = 'active'`
      const [row] = await tx`
        update workflow_versions set status = 'active'
        where guild_id = ${guildId} and workflow_id = ${riteId} and version = ${version}
        returning ${tx.unsafe(VERSION_COLUMNS)}`
      await appendEvent(tx, this.keys, RITE_EVENT.versionConfirmed, { riteId, version })
      return { ok: true, version: toVersion(versionRow.parse(row)) }
    })
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; archived?: boolean }
  ): Promise<RitePage> {
    const after = page.after ?? null
    const archived = page.archived === true
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select v.workflow_id,
          (array_agg(v.name order by v.version desc))[1] as name,
          max(v.version)::int as latest_version,
          max(v.version) filter (where v.status = 'active')::int as active_version,
          max(v.created_at) as updated_at,
          a.archived_at
        from workflow_versions v
        left join workflow_archive a
          on a.guild_id = v.guild_id and a.workflow_id = v.workflow_id
        where v.guild_id = ${guildId}
          and (${after}::text is null or v.workflow_id > ${after}::text)
          and (a.archived_at is not null) = ${archived}
        group by v.workflow_id, a.archived_at
        order by v.workflow_id limit ${page.limit + 1}`
      const all = rows.map((r) => {
        const s = summaryRow.parse(r)
        return {
          id: s.workflow_id,
          name: s.name,
          latestVersion: s.latest_version,
          activeVersion: s.active_version,
          updatedAt: s.updated_at,
          archivedAt: s.archived_at,
        }
      })
      const rites = all.slice(0, page.limit)
      const last = rites.at(-1)
      return { rites, next: all.length > page.limit && last ? last.id : null }
    })
  }

  async archivedAt(guildId: string, riteId: string): Promise<string | null> {
    return this.db.withGuild(guildId, (tx) => this.archivedAtIn(tx, guildId, riteId))
  }

  private async archivedAtIn(
    tx: TenantTx,
    guildId: string,
    riteId: string
  ): Promise<string | null> {
    const [row] = await tx`
      select archived_at from workflow_archive
      where guild_id = ${guildId} and workflow_id = ${riteId}`
    return row ? z.object({ archived_at: date.nullable() }).parse(row).archived_at : null
  }

  private async exists(tx: TenantTx, guildId: string, riteId: string): Promise<boolean> {
    const [row] = await tx`
      select 1 as one from workflow_versions where guild_id = ${guildId} and workflow_id = ${riteId}
      limit 1`
    return row !== undefined
  }

  async archive(guildId: string, riteId: string): Promise<ArchiveResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
      if (!(await this.exists(tx, guildId, riteId))) {
        return { ok: false, error: 'not_found' }
      }
      const existing = await this.archivedAtIn(tx, guildId, riteId)
      if (existing !== null) {
        return { ok: true, changed: false, archivedAt: existing }
      }
      await tx`
        insert into workflow_archive (guild_id, workflow_id, archived_at)
        values (${guildId}, ${riteId}, ${now})
        on conflict (guild_id, workflow_id) do update set archived_at = excluded.archived_at`
      await appendEvent(tx, this.keys, RITE_EVENT.archived, { riteId })
      return { ok: true, changed: true, archivedAt: now.toISOString() }
    })
  }

  async unarchive(guildId: string, riteId: string): Promise<UnarchiveResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`${guildId}:${riteId}`}, 0))`
      if (!(await this.exists(tx, guildId, riteId))) {
        return { ok: false, error: 'not_found' }
      }
      if ((await this.archivedAtIn(tx, guildId, riteId)) === null) {
        return { ok: true, changed: false, superseded: null }
      }
      await tx`
        update workflow_archive set archived_at = null
        where guild_id = ${guildId} and workflow_id = ${riteId}`
      const [row] = await tx`
        update workflow_versions set status = 'superseded'
        where guild_id = ${guildId} and workflow_id = ${riteId} and status = 'active'
        returning version`
      const superseded = row ? z.object({ version: z.number() }).parse(row).version : null
      await appendEvent(tx, this.keys, RITE_EVENT.unarchived, { riteId, superseded })
      return { ok: true, changed: true, superseded }
    })
  }

  async versions(
    guildId: string,
    riteId: string,
    page: { before?: number; limit: number }
  ): Promise<RiteVersionPage> {
    const before = page.before ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(VERSION_COLUMNS)} from workflow_versions
        where guild_id = ${guildId} and workflow_id = ${riteId}
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
    input: { riteId: string; version: number; runKey: string }
  ): Promise<{ instance: RiteRun; created: boolean }> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const [inserted] = await tx`
        insert into workflow_instances (guild_id, workflow_id, version, run_key, created_at)
        values (${guildId}, ${input.riteId}, ${input.version}, ${input.runKey}, ${now})
        on conflict (guild_id, workflow_id, run_key) do nothing
        returning ${tx.unsafe(INSTANCE_COLUMNS)}`
      if (inserted) {
        const instance = toInstance(instanceRow.parse(inserted))
        await appendEvent(tx, this.keys, RITE_EVENT.runStarted, {
          instanceId: instance.id,
          riteId: instance.riteId,
          version: instance.version,
        })
        return { instance, created: true }
      }
      const [existing] = await tx`
        select ${tx.unsafe(INSTANCE_COLUMNS)} from workflow_instances
        where guild_id = ${guildId} and workflow_id = ${input.riteId}
          and run_key = ${input.runKey}`
      return { instance: toInstance(instanceRow.parse(existing)), created: false }
    })
  }

  async getInstance(guildId: string, id: string): Promise<RiteRun | null> {
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
    riteId: string,
    page: { after?: string; limit: number }
  ): Promise<RiteRunPage> {
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select ${tx.unsafe(INSTANCE_COLUMNS)} from workflow_instances
        where guild_id = ${guildId} and workflow_id = ${riteId}
          and (${after}::uuid is null or instance_id > ${after}::uuid)
        order by instance_id limit ${page.limit + 1}`
      const all = rows.map((r) => toInstance(instanceRow.parse(r)))
      const instances = all.slice(0, page.limit)
      const last = instances.at(-1)
      return { instances, next: all.length > page.limit && last ? last.id : null }
    })
  }
}
