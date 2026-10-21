import { inquiryStoreContract } from '../ports/inquiry-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryInquiryStore } from './memory-inquiry-store'
import { MemoryQuestQueue } from './memory-quest-queue'

inquiryStoreContract('memory', async () => {
  const quests = new MemoryQuestQueue(new MemoryClock(new Date('2026-01-01T00:00:00.000Z')))
  return {
    store: new MemoryInquiryStore(quests),
    quests,
    newGuild: async () => crypto.randomUUID(),
  }
})
