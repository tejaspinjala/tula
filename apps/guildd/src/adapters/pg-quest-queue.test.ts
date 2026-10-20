import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import type { NewQuest } from '../ports/quest-queue'
import { questQueueContract } from '../ports/quest-queue.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgQuestQueue } from './pg-quest-queue'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const START = new Date('2030-01-01T00:00:00.000Z')
const newGuild = () => foundTestGuild(db, { name: 'Board', goal: 'g' })

questQueueContract('postgres', async () => {
  const clock = new MemoryClock(START)
  const events = async (guildId: string) =>
    (
      await owner`
        select type from events where guild_id = ${guildId} and type like 'quest.%' order by seq`
    ).map((e) => String(e.type))
  return {
    queue: new PgQuestQueue(db, new MemoryKeyProvider(), clock, () => 0.5),
    clock,
    newGuild,
    events,
  }
})

test('Quest transitions append events with ids only', async () => {
  const guild = await newGuild()
  const clock = new MemoryClock(START)
  const queue = new PgQuestQueue(db, new MemoryKeyProvider(), clock, () => 0.5)
  const input: NewQuest = {
    jobKey: 'ev-1',
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'secret-title-text',
    ownerId: 'heralds-member-2',
    doneCondition: 'secret-condition-text',
    roundLimit: 1,
  }
  const { quest } = await queue.post(guild, input)
  await queue.post(guild, input)
  await queue.claim(guild, { leaseMs: 1000, maxActive: 5 })
  await queue.complete(guild, quest.id, 1)
  await queue.complete(guild, quest.id, 1)
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type like 'quest.%' order by seq`
  expect(events.map((e) => e.type)).toEqual(['quest.posted', 'quest.claimed', 'quest.done'])
  expect(JSON.stringify(events)).not.toContain('secret')
  expect(events[2]?.payload).toEqual({ questId: quest.id, hallId: 'heralds', attempt: 1 })
})
