import { MemoryTreasuryStore } from '../adapters/memory-treasury-store'

/**
 * Test-only: a {@link MemoryTreasuryStore} that can rewrite a stored entry behind the store's
 * back, as a hostile database administrator would. Never composed into the app.
 */
export class TamperableMemoryTreasuryStore extends MemoryTreasuryStore {
  /** Rewrites an entry's amount without re-hashing it. */
  tamperForTest(guildId: string, seq: number, amountCents: number): void {
    const state = this.stateOf(guildId)
    state.entries = state.entries.map((e) => (e.seq === seq ? { ...e, amountCents } : e))
  }
}
