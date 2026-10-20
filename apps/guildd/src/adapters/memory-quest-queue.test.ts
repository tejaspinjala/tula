import { questQueueContract } from '../ports/quest-queue.contract'
import { MemoryClock } from './memory-clock'
import { MemoryQuestQueue } from './memory-quest-queue'

questQueueContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const log: Array<{ guildId: string; type: string }> = []
  return {
    queue: new MemoryQuestQueue(
      clock,
      () => 0.5,
      (guildId, type) => log.push({ guildId, type })
    ),
    events: async (guildId: string) => log.filter((e) => e.guildId === guildId).map((e) => e.type),
    clock,
    newGuild: async () => crypto.randomUUID(),
  }
})
