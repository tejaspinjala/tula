import type { Clock } from '../ports/clock'
import type {
  ActivateResult,
  NewRiteVersion,
  PublishDraftResult,
  RitePage,
  RiteRun,
  RiteRunPage,
  RiteStore,
  RiteSummary,
  RiteVersion,
  RiteVersionPage,
} from '../ports/rite-store'

interface GuildState {
  /** Versions per rite id, in version order (index + 1 is the version number). */
  rites: Map<string, RiteVersion[]>
  instances: Map<string, RiteRun>
  /** The active version each published-pending version was published over, keyed `rite:version`. */
  basedOn: Map<string, number | null>
}

/**
 * Memory adapter for {@link RiteStore}: state in this instance only. Every method checks and
 * writes with no await in between, so same-tick saves and runs cannot interleave.
 */
export class MemoryRiteStore implements RiteStore {
  private readonly guilds = new Map<string, GuildState>()

  constructor(private readonly clock: Clock) {}

  private state(guildId: string): GuildState {
    let s = this.guilds.get(guildId)
    if (!s) {
      s = { rites: new Map(), instances: new Map(), basedOn: new Map() }
      this.guilds.set(guildId, s)
    }
    return s
  }

  async saveVersion(guildId: string, riteId: string, input: NewRiteVersion): Promise<RiteVersion> {
    const { rites } = this.state(guildId)
    const list = rites.get(riteId) ?? []
    const saved: RiteVersion = {
      ...structuredClone(input),
      riteId,
      version: list.length + 1,
      createdAt: this.clock.now().toISOString(),
    }
    rites.set(riteId, [...list, saved])
    return structuredClone(saved)
  }

  async seedVersion(
    guildId: string,
    riteId: string,
    input: NewRiteVersion
  ): Promise<RiteVersion | null> {
    if (this.state(guildId).rites.has(riteId)) {
      return null
    }
    return this.saveVersion(guildId, riteId, input)
  }

  async getVersion(guildId: string, riteId: string, version?: number): Promise<RiteVersion | null> {
    const list = this.state(guildId).rites.get(riteId) ?? []
    const found = version === undefined ? list.at(-1) : list[version - 1]
    return found ? structuredClone(found) : null
  }

  async latestActive(guildId: string, riteId: string): Promise<RiteVersion | null> {
    const list = this.state(guildId).rites.get(riteId) ?? []
    const found = list.findLast((v) => v.status === 'active')
    return found ? structuredClone(found) : null
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
    const list = this.state(guildId).rites.get(riteId) ?? []
    const draft = list[input.version - 1]
    if (!draft) {
      return { ok: false, error: 'not_found' }
    }
    if (draft.status !== 'draft') {
      return { ok: false, error: 'not_draft' }
    }
    const current = list.findLast((v) => v.status === 'active')
    if ((current?.version ?? null) !== input.basedOn || input.basedOn !== input.classifiedAgainst) {
      return { ok: false, error: 'stale' }
    }
    if (input.outcome === 'active' && current) {
      current.status = 'superseded'
    }
    draft.status = input.outcome
    this.state(guildId).basedOn.set(`${riteId}:${draft.version}`, current?.version ?? null)
    return { ok: true, version: structuredClone(draft) }
  }

  async activate(guildId: string, riteId: string, version: number): Promise<ActivateResult> {
    const list = this.state(guildId).rites.get(riteId) ?? []
    const found = list[version - 1]
    if (!found) {
      return { ok: false, error: 'not_found' }
    }
    if (found.status === 'pending') {
      const over = this.state(guildId).basedOn.get(`${riteId}:${version}`) ?? null
      if ((list.findLast((v) => v.status === 'active')?.version ?? null) !== over) {
        return { ok: false, error: 'stale' }
      }
      for (const v of list) {
        if (v.status === 'active') {
          v.status = 'superseded'
        }
      }
      found.status = 'active'
    }
    return { ok: true, version: structuredClone(found) }
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<RitePage> {
    const summaries: RiteSummary[] = []
    for (const [id, list] of this.state(guildId).rites) {
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
    const rites = summaries.slice(0, page.limit)
    const last = rites.at(-1)
    return { rites, next: summaries.length > page.limit && last ? last.id : null }
  }

  async versions(
    guildId: string,
    riteId: string,
    page: { before?: number; limit: number }
  ): Promise<RiteVersionPage> {
    const all = [...(this.state(guildId).rites.get(riteId) ?? [])]
      .filter((v) => page.before === undefined || v.version < page.before)
      .reverse()
    const versions = all.slice(0, page.limit).map((v) => structuredClone(v))
    const last = versions.at(-1)
    return { versions, next: all.length > page.limit && last ? last.version : null }
  }

  async createInstance(
    guildId: string,
    input: { riteId: string; version: number; runKey: string }
  ): Promise<{ instance: RiteRun; created: boolean }> {
    const s = this.state(guildId)
    if (!s.rites.get(input.riteId)?.[input.version - 1]) {
      throw new Error('rite version not found')
    }
    for (const existing of s.instances.values()) {
      if (existing.riteId === input.riteId && existing.runKey === input.runKey) {
        return { instance: structuredClone(existing), created: false }
      }
    }
    const instance: RiteRun = {
      id: crypto.randomUUID(),
      ...input,
      createdAt: this.clock.now().toISOString(),
    }
    s.instances.set(instance.id, instance)
    return { instance: structuredClone(instance), created: true }
  }

  async getInstance(guildId: string, id: string): Promise<RiteRun | null> {
    const found = this.state(guildId).instances.get(id)
    return found ? structuredClone(found) : null
  }

  async listInstances(
    guildId: string,
    riteId: string,
    page: { after?: string; limit: number }
  ): Promise<RiteRunPage> {
    const all = [...this.state(guildId).instances.values()]
      .filter((i) => i.riteId === riteId && (page.after === undefined || i.id > page.after))
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const instances = all.slice(0, page.limit).map((i) => structuredClone(i))
    const last = instances.at(-1)
    return { instances, next: all.length > page.limit && last ? last.id : null }
  }
}
