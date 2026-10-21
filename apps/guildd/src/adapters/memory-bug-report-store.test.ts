import { bugReportStoreContract } from '../ports/bug-report-store.contract'
import { MemoryBugReportStore } from './memory-bug-report-store'
import { MemoryClock } from './memory-clock'
import { MemoryQuestQueue } from './memory-quest-queue'

bugReportStoreContract('memory', async () => {
  const quests = new MemoryQuestQueue(new MemoryClock(new Date('2030-01-01T00:00:00.000Z')))
  return {
    store: new MemoryBugReportStore(quests),
    quests,
    newGuild: async () => crypto.randomUUID(),
  }
})
