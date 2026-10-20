import { afterAll } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { handoffStoreContract } from '../ports/handoff-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgHandoffStore } from './pg-handoff-store'
import { PgQuestQueue } from './pg-quest-queue'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

handoffStoreContract('postgres', async () => {
  const keys = new MemoryKeyProvider()
  const queue = new PgQuestQueue(db, keys, new MemoryClock(new Date('2030-01-01T00:00:00.000Z')))
  return {
    store: new PgHandoffStore(db, keys),
    newGuild: () => foundTestGuild(db, { name: 'Handoffs', goal: 'g' }),
    newQuest: async (guildId: string) =>
      (
        await queue.post(guildId, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-brief',
          hallId: 'heralds',
          rank: 'journeyman',
          dataClass: 'internal',
          title: 'Draft the brief',
          ownerId: 'heralds-member-2',
          doneCondition: 'A draft brief is filed',
          roundLimit: 2,
        })
      ).quest.id,
    events: async (guildId: string) =>
      (
        await owner`
          select type, payload from events
          where guild_id = ${guildId} and type in ('handoff.recorded', 'artifact.attached')
          order by seq`
      ).map((e) => ({ type: String(e.type), payload: e.payload })),
  }
})
