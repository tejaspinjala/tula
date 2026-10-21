import { configStoreContract } from '../ports/config-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryConfigStore } from './memory-config-store'
import { MemoryQuestQueue } from './memory-quest-queue'

configStoreContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock)
  return {
    store: new MemoryConfigStore(clock, { quests }),
    newGuild: async () => crypto.randomUUID(),
    activeQuest: async (guildId, hallId) => {
      const { quest } = await quests.post(guildId, questIn(hallId))
      await quests.claim(guildId, { leaseMs: 60_000, maxActive: 5, questId: quest.id })
      return {
        read: async () => {
          const q = await quests.get(guildId, quest.id)
          return { state: q?.state ?? 'missing', leaseExpiresAt: q?.leaseExpiresAt ?? null }
        },
      }
    },
  }
})

function questIn(hallId: string) {
  return {
    jobKey: `lock-${crypto.randomUUID()}`,
    templateId: 'herald-brief',
    hallId,
    rank: 'journeyman' as const,
    dataClass: 'internal' as const,
    title: 't',
    ownerId: 'heralds-member-2',
    doneCondition: 'c',
    roundLimit: 1,
  }
}
