import { toolsetStoreContract } from '../ports/toolset-store.contract'
import { MemoryToolsetStore } from './memory-toolset-store'

toolsetStoreContract('memory', async () => ({
  store: new MemoryToolsetStore(),
  newGuild: async () => crypto.randomUUID(),
}))
