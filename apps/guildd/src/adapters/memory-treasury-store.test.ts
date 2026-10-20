import { treasuryStoreContract } from '../ports/treasury-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryTreasuryStore } from './memory-treasury-store'

treasuryStoreContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T12:00:00.000Z'))
  return {
    store: new MemoryTreasuryStore(clock),
    newGuild: async () => crypto.randomUUID(),
    advanceMs: (ms: number) => clock.advance(ms),
  }
})
