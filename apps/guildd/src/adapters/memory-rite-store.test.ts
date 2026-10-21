import { riteStoreContract } from '../ports/rite-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryRiteStore } from './memory-rite-store'

riteStoreContract('memory', async () => ({
  store: new MemoryRiteStore(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
  newGuild: async () => crypto.randomUUID(),
}))
