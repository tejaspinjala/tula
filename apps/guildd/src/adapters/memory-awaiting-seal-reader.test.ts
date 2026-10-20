import { awaitingSealReaderContract } from '../ports/awaiting-seal-reader.contract'
import { MemoryAwaitingSealReader } from './memory-awaiting-seal-reader'
import { MemoryClock } from './memory-clock'
import { MemoryQuestQueue } from './memory-quest-queue'
import { MemorySealStore } from './memory-seal-store'

awaitingSealReaderContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const seals = new MemorySealStore(clock)
  return {
    reader: new MemoryAwaitingSealReader(quests, seals),
    quests,
    seals,
    clock,
    newGuild: async () => crypto.randomUUID(),
  }
})
