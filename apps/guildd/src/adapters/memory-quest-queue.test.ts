import { questQueueContract } from '../ports/quest-queue.contract'
import { MemoryClock } from './memory-clock'
import { MemoryQuestQueue } from './memory-quest-queue'

questQueueContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  return {
    queue: new MemoryQuestQueue(clock, () => 0.5),
    clock,
    newGuild: async () => crypto.randomUUID(),
  }
})
