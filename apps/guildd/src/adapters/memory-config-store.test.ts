import { configStoreContract } from '../ports/config-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryConfigStore } from './memory-config-store'

configStoreContract('memory', async () => ({
  store: new MemoryConfigStore(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
  newGuild: async () => crypto.randomUUID(),
}))
