import { researchStoreContract } from '../ports/research-store.contract'
import { MemoryResearchStore } from './memory-research-store'

researchStoreContract('memory', async () => ({
  store: new MemoryResearchStore(),
  newGuild: async () => crypto.randomUUID(),
}))
