import { proposalStoreContract } from '../ports/proposal-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryProposalStore } from './memory-proposal-store'

proposalStoreContract('memory', async () => ({
  store: new MemoryProposalStore(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
  newGuild: async () => crypto.randomUUID(),
}))
