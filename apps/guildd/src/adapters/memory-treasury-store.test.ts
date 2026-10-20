import { treasuryStoreContract } from '../ports/treasury-store.contract'
import { TamperableMemoryTreasuryStore } from '../testing/tamperable-memory-treasury-store'
import { MemoryClock } from './memory-clock'

treasuryStoreContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T12:00:00.000Z'))
  const store = new TamperableMemoryTreasuryStore(clock)
  return {
    store,
    tamper: async (guildId: string, seq: number, amountCents: number) =>
      store.tamperForTest(guildId, seq, amountCents),
    newGuild: async () => crypto.randomUUID(),
    advanceMs: (ms: number) => clock.advance(ms),
  }
})
