import {
  MAX_USAGE_PAGE,
  type ModelLedger,
  type NewRun,
  type RunRecord,
  type Totals,
  type UsageEntry,
  type UsageGroup,
  type UsagePage,
  type UsageRow,
} from '../ports/model-ledger'

interface StoredRun extends RunRecord {
  tokenHash: string | null
  seq: number
}
interface StoredUsage extends UsageEntry {
  questId: string
  hallId: string
}
interface GuildState {
  runs: Map<string, StoredRun>
  usage: Map<string, StoredUsage>
  notices: Set<string>
}

const view = ({ tokenHash: _hash, seq: _seq, ...record }: StoredRun): RunRecord => record

/** Memory {@link ModelLedger}: same rules, state in this instance only. */
export class MemoryModelLedger implements ModelLedger {
  private readonly guilds = new Map<string, GuildState>()

  private state(guildId: string): GuildState {
    const found = this.guilds.get(guildId)
    if (found) {
      return found
    }
    const fresh: GuildState = { runs: new Map(), usage: new Map(), notices: new Set() }
    this.guilds.set(guildId, fresh)
    return fresh
  }

  // Every method checks and writes with no await between them, so same-tick calls cannot interleave.
  async openRun(guildId: string, run: NewRun): Promise<'created' | 'exists'> {
    const s = this.state(guildId)
    if (s.runs.has(run.runId)) {
      return 'exists'
    }
    s.runs.set(run.runId, {
      runId: run.runId,
      questId: run.questId,
      hallId: run.hallId,
      providerId: run.providerId,
      profileId: run.profileId,
      state: run.state,
      expiresAt: run.expiresAt,
      tokenHash: run.tokenHash,
      seq: s.runs.size + 1,
    })
    return 'created'
  }

  async activate(
    guildId: string,
    runId: string,
    tokenHash: string,
    expiresAt: string
  ): Promise<boolean> {
    const found = this.state(guildId).runs.get(runId)
    if (found?.state !== 'queued') {
      return false
    }
    found.state = 'active'
    found.tokenHash = tokenHash
    found.expiresAt = expiresAt
    return true
  }

  async findByTokenHash(guildId: string, tokenHash: string): Promise<RunRecord | null> {
    for (const r of this.state(guildId).runs.values()) {
      if (r.tokenHash === tokenHash) {
        return view(r)
      }
    }
    return null
  }

  async getRun(guildId: string, runId: string): Promise<RunRecord | null> {
    const found = this.state(guildId).runs.get(runId)
    return found ? view(found) : null
  }

  async revoke(guildId: string, runId: string): Promise<boolean> {
    const found = this.state(guildId).runs.get(runId)
    if (!found) {
      return false
    }
    found.state = 'revoked'
    return true
  }

  async listQueued(guildId: string, limit: number): Promise<RunRecord[]> {
    return [...this.state(guildId).runs.values()]
      .filter((r) => r.state === 'queued')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.max(0, limit))
      .map(view)
  }

  async recordUsage(guildId: string, entry: UsageEntry): Promise<void> {
    const s = this.state(guildId)
    const owner = s.runs.get(entry.runId)
    if (!owner) {
      throw new Error('usage for an unknown run')
    }
    if (!s.usage.has(entry.callKey)) {
      s.usage.set(entry.callKey, { ...entry, questId: owner.questId, hallId: owner.hallId })
    }
  }

  async dayTotals(guildId: string, day: string): Promise<Totals> {
    const totals = { tokens: 0, costMicros: 0 }
    for (const u of this.state(guildId).usage.values()) {
      if (u.day === day) {
        totals.tokens += u.inputTokens + u.outputTokens
        totals.costMicros += u.costMicros ?? 0
      }
    }
    return totals
  }

  async report(
    guildId: string,
    by: UsageGroup,
    page: { after?: string; limit: number }
  ): Promise<UsagePage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_USAGE_PAGE)
    const keyOf = (u: StoredUsage): string => {
      switch (by) {
        case 'run':
          return u.runId
        case 'quest':
          return u.questId
        case 'hall':
          return u.hallId
        default:
          return u.day
      }
    }
    const rows = new Map<string, UsageRow>()
    for (const u of this.state(guildId).usage.values()) {
      const key = keyOf(u)
      const row = rows.get(key) ?? { key, calls: 0, inputTokens: 0, outputTokens: 0, costMicros: 0 }
      row.calls += 1
      row.inputTokens += u.inputTokens
      row.outputTokens += u.outputTokens
      row.costMicros += u.costMicros ?? 0
      rows.set(key, row)
    }
    const after = page.after
    const ordered = [...rows.values()]
      .filter((r) => after === undefined || r.key > after)
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    const slice = ordered.slice(0, limit)
    const last = slice.at(-1)
    return { rows: slice, next: ordered.length > limit && last ? last.key : null }
  }

  async noteCapReached(guildId: string, day: string, _reason: string): Promise<boolean> {
    const notices = this.state(guildId).notices
    if (notices.has(day)) {
      return false
    }
    notices.add(day)
    return true
  }
}
