import { missiveStoreContract } from '../ports/missive-store.contract'
import { MemoryMissiveStore } from './memory-missive-store'

missiveStoreContract('memory', async () => ({
  store: new MemoryMissiveStore(),
  newGuild: async () => crypto.randomUUID(),
}))
