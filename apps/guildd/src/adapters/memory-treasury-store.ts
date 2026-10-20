import type { Clock } from '../ports/clock'
import type { Balances, LedgerEntry, Spend, TreasuryStore } from '../ports/treasury-store'
import { TreasuryCore, type TreasuryTx } from '../treasury-core'

interface GuildState {
  entries: LedgerEntry[]
  spends: Spend[]
}

/**
 * Memory adapter for {@link TreasuryStore}. It keeps Postgres's atomicity: every unit of work
 * for a guild is chained behind the previous one, so a check and the append it guards never
 * interleave, even for same-tick callers. State lives in the instance only.
 */
export class MemoryTreasuryStore extends TreasuryCore implements TreasuryStore {
  private readonly guilds = new Map<string, GuildState>()
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(
    clock: Clock,
    private readonly onEvent: (
      guildId: string,
      type: string,
      payload: Record<string, string | number>
    ) => void = () => {}
  ) {
    super(clock)
  }

  protected run<T>(
    guildId: string,
    _mode: 'read' | 'write',
    fn: (tx: TreasuryTx) => Promise<T>
  ): Promise<T> {
    const before = this.queues.get(guildId) ?? Promise.resolve()
    const result = before.then(() => fn(this.txFor(guildId)))
    this.queues.set(
      guildId,
      result.then(
        () => undefined,
        () => undefined
      )
    )
    return result
  }

  private stateOf(guildId: string): GuildState {
    const found = this.guilds.get(guildId)
    if (found) {
      return found
    }
    const fresh: GuildState = { entries: [], spends: [] }
    this.guilds.set(guildId, fresh)
    return fresh
  }

  private txFor(guildId: string): TreasuryTx {
    const state = this.stateOf(guildId)
    return {
      lastEntry: async () => state.entries.at(-1) ?? null,
      balances: async () => {
        const sums: Balances = { operating: 0, reserve: 0, profit: 0 }
        for (const e of state.entries) {
          sums[e.bucket] += e.amountCents
        }
        return sums
      },
      spentOn: async (day) =>
        0 -
        state.entries
          .filter(
            (e) =>
              e.day === day &&
              e.bucket === 'operating' &&
              (e.kind === 'spend_reserve' ||
                e.kind === 'spend_settle' ||
                e.kind === 'spend_release')
          )
          .reduce((sum, e) => sum + e.amountCents, 0),
      entriesByKey: async (key) => state.entries.filter((e) => e.idemKey === key),
      append: async (entry) => {
        state.entries.push(entry)
      },
      entriesAfter: async (after, limit) =>
        state.entries.filter((e) => e.seq > after).slice(0, limit),
      spendByKey: async (key) => state.spends.find((sp) => sp.key === key) ?? null,
      spendById: async (id) => state.spends.find((sp) => sp.id === id) ?? null,
      spendsAfter: async (after, limit) =>
        state.spends.filter((sp) => sp.seq > after).slice(0, limit),
      updateSpend: async (spend) => {
        const at = state.spends.findIndex((sp) => sp.id === spend.id)
        if (at >= 0) {
          state.spends[at] = spend
        }
      },
      insertSpend: async (spend) => {
        const row: Spend = { ...spend, seq: state.spends.length + 1 }
        state.spends.push(row)
        return row
      },
      emit: async (type, payload) => this.onEvent(guildId, type, payload),
    }
  }

  /** Test seam: rewrites a stored entry's amount without re-hashing it, as tampering would. */
  tamperForTest(guildId: string, seq: number, amountCents: number): void {
    const state = this.stateOf(guildId)
    state.entries = state.entries.map((e) => (e.seq === seq ? { ...e, amountCents } : e))
  }
}
