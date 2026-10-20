import type { Clock } from '../ports/clock'
import type {
  Balances,
  LedgerEntry,
  Spend,
  SpendResult,
  TreasuryStore,
} from '../ports/treasury-store'
import { TreasuryCore, type TreasuryTx } from '../treasury-core'

interface GuildState {
  entries: LedgerEntry[]
}

const todo = (): never => {
  throw new Error('not implemented')
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
    const fresh: GuildState = { entries: [] }
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
      emit: async (type, payload) => this.onEvent(guildId, type, payload),
    }
  }

  async requestSpend(): Promise<SpendResult> {
    return todo()
  }
  async approveSpend(): Promise<SpendResult> {
    return todo()
  }
  async denySpend(): Promise<SpendResult> {
    return todo()
  }
  async settleSpend(): Promise<SpendResult> {
    return todo()
  }
  async releaseSpend(): Promise<SpendResult> {
    return todo()
  }
  async getSpend(): Promise<Spend | null> {
    return todo()
  }
  async listSpends(): Promise<never> {
    return todo()
  }
  async releaseReserve(): Promise<never> {
    return todo()
  }
}
