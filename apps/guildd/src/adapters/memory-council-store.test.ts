import { councilStoreContract } from '../ports/council-store.contract'
import { MemoryCouncilStore } from './memory-council-store'

councilStoreContract('memory', async () => ({
  store: new MemoryCouncilStore(),
  newGuild: async () => crypto.randomUUID(),
}))
