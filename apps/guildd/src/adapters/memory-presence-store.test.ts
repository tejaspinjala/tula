import { presenceStoreContract } from '../ports/presence-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryPresenceStore } from './memory-presence-store'

presenceStoreContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  return { store: new MemoryPresenceStore(clock), clock, newGuild: async () => crypto.randomUUID() }
})
