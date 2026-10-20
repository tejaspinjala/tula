import {
  type HallDayTotals,
  isUsageDate,
  MAX_USAGE_PAGE,
  type ModelLedger,
  type NewRun,
  type Reservation,
  type ReserveResult,
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
  clientKeys: Set<string>
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
    const fresh: GuildState = {
      runs: new Map(),
      usage: new Map(),
      notices: new Set(),
      clientKeys: new Set(),
    }
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
      attempt: run.attempt,
      hallId: run.hallId,
      providerId: run.providerId,
      profileId: run.profileId,
      state: run.state,
      revokeReason: null,
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
    if (
      !found ||
      !(
        found.state === 'queued' ||
        (found.state === 'revoked' && found.revokeReason === 'hall_paused')
      )
    ) {
      return false
    }
    found.state = 'active'
    found.revokeReason = null
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
    found.revokeReason = 'manual'
    return true
  }

  async revokeHallRuns(guildId: string, hallId: string): Promise<number> {
    let revoked = 0
    for (const r of this.state(guildId).runs.values()) {
      if (r.hallId === hallId && r.state !== 'revoked') {
        r.state = 'revoked'
        r.revokeReason = 'hall_paused'
        revoked += 1
      }
    }
    return revoked
  }

  async revokeAllRuns(): Promise<number> {
    let revoked = 0
    for (const guildId of this.guilds.keys()) {
      revoked += await this.revokeGuildRuns(guildId)
    }
    return revoked
  }

  async revokeGuildRuns(guildId: string): Promise<number> {
    let revoked = 0
    for (const r of this.state(guildId).runs.values()) {
      if (r.state !== 'revoked' || r.revokeReason === 'hall_paused') {
        r.state = 'revoked'
        r.revokeReason = 'manual'
        revoked += 1
      }
    }
    return revoked
  }

  async listQueued(guildId: string, limit: number): Promise<RunRecord[]> {
    return [...this.state(guildId).runs.values()]
      .filter((r) => r.state === 'queued')
      .sort((a, b) => a.seq - b.seq)
      .slice(0, Math.max(0, limit))
      .map(view)
  }

  // The cap check and the charge happen with no await between them, so parallel reservations
  // cannot both pass a cap that admits one.
  async reserve(guildId: string, r: Reservation): Promise<ReserveResult> {
    const s = this.state(guildId)
    const owner = s.runs.get(r.runId)
    if (!owner) {
      throw new Error('usage for an unknown run')
    }
    const scoped = r.clientKey === null ? null : `${r.runId}\u0000${r.clientKey}`
    if (scoped !== null && s.clientKeys.has(scoped)) {
      return { status: 'duplicate' }
    }
    const totals = this.totalsOf(s, r.day)
    if (totals.tokens + r.inputTokens + r.outputTokens > r.caps.tokens) {
      return { status: 'cap_reached', reason: 'daily_tokens' }
    }
    if (totals.costMicros + (r.costMicros ?? 0) > r.caps.costMicros) {
      return { status: 'cap_reached', reason: 'daily_spend' }
    }
    if (scoped !== null) {
      s.clientKeys.add(scoped)
    }
    const { clientKey: _k, caps: _c, ...entry } = r
    s.usage.set(r.callKey, { ...entry, questId: owner.questId, hallId: owner.hallId })
    return { status: 'reserved' }
  }

  async settle(
    guildId: string,
    callKey: string,
    actual: { inputTokens: number; outputTokens: number; costMicros: number | null }
  ): Promise<void> {
    const found = this.state(guildId).usage.get(callKey)
    if (found) {
      found.inputTokens = actual.inputTokens
      found.outputTokens = actual.outputTokens
      found.costMicros = actual.costMicros
    }
  }

  private totalsOf(s: GuildState, day: string): Totals {
    const totals = { tokens: 0, costMicros: 0 }
    for (const u of s.usage.values()) {
      if (u.day === day) {
        totals.tokens += u.inputTokens + u.outputTokens
        totals.costMicros += u.costMicros ?? 0
      }
    }
    return totals
  }

  async dayTotals(guildId: string, day: string): Promise<Totals> {
    return this.totalsOf(this.state(guildId), day)
  }

  async hallDayTotals(
    _guildId: string,
    _hallId: string,
    _range: { from: string; to: string }
  ): Promise<HallDayTotals[]> {
    throw new Error('not implemented')
  }

  async report(
    guildId: string,
    by: UsageGroup,
    page: { after?: string; limit: number }
  ): Promise<UsagePage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_USAGE_PAGE)
    if (by === 'day' && page.after !== undefined && !isUsageDate(page.after)) {
      return { rows: [], next: null }
    }
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
