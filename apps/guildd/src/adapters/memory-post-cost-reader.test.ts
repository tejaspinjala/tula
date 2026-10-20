import { postCostReaderContract } from '../ports/post-cost-reader.contract'
import { MemoryClock } from './memory-clock'
import { MemoryModelLedger } from './memory-model-ledger'
import { MemoryPostCostReader } from './memory-post-cost-reader'
import { MemoryQuestQueue } from './memory-quest-queue'
import { MemorySealStore } from './memory-seal-store'

postCostReaderContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const seals = new MemorySealStore(clock)
  const ledger = new MemoryModelLedger()
  return {
    reader: new MemoryPostCostReader({ ledger, quests, sealStore: seals }),
    quests,
    ledger,
    seals,
    newGuild: async () => crypto.randomUUID(),
  }
})
