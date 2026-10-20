import type { Clock } from '../ports/clock'
import type {
  EntriesResult,
  LedgerEntry,
  LedgerVerdict,
  Spend,
  SpendResult,
  TreasuryPage,
  TreasurySnapshot,
  TreasuryStore,
} from '../ports/treasury-store'

const todo = (): never => {
  throw new Error('not implemented')
}

/** Memory adapter for {@link TreasuryStore}. */
export class MemoryTreasuryStore implements TreasuryStore {
  constructor(private readonly clock: Clock) {}

  async snapshot(): Promise<TreasurySnapshot> {
    return todo()
  }
  async recordRevenue(): Promise<EntriesResult> {
    return todo()
  }
  async releaseReserve(): Promise<EntriesResult> {
    return todo()
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
  async listSpends(): Promise<TreasuryPage<Spend>> {
    return todo()
  }
  async listEntries(): Promise<TreasuryPage<LedgerEntry>> {
    return todo()
  }
  async verifyLedger(): Promise<LedgerVerdict> {
    return todo()
  }
}
