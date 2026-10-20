import { sealStoreContract } from '../ports/seal-store.contract'
import { MemoryClock } from './memory-clock'
import { MemorySealStore } from './memory-seal-store'

sealStoreContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  return { store: new MemorySealStore(clock), clock, newGuild: async () => crypto.randomUUID() }
})
