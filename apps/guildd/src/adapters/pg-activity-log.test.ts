import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { activityLogContract } from '../ports/activity-log.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgActivityLog } from './pg-activity-log'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

activityLogContract('postgres', async () => ({
  log: new PgActivityLog(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Activity', goal: 'g' }),
}))

const input = {
  questId: crypto.randomUUID(),
  memberId: 'm-ada',
  hallId: 'h-forge',
  activity: 'researching',
  at: new Date(),
  windowMs: 5000,
} as const

test('an emitted activity appends member.activity with ids and the enum only', async () => {
  const guild = await foundTestGuild(db, { name: 'Activity', goal: 'g' })
  await new PgActivityLog(db, new MemoryKeyProvider()).record(guild, input)
  const events = await owner`
    select payload from events where guild_id = ${guild} and type = 'member.activity'`
  expect(events).toHaveLength(1)
  expect(events[0]?.payload).toEqual({
    questId: input.questId,
    memberId: 'm-ada',
    hallId: 'h-forge',
    activity: 'researching',
  })
})

test('a coalesced activity appends no event', async () => {
  const guild = await foundTestGuild(db, { name: 'Activity', goal: 'g' })
  const log = new PgActivityLog(db, new MemoryKeyProvider())
  await log.record(guild, input)
  await log.record(guild, input)
  const events = await owner`
    select 1 from events where guild_id = ${guild} and type = 'member.activity'`
  expect(events).toHaveLength(1)
})

test('a guild sees no activity row of another guild, and a forged insert is refused', async () => {
  const a = await foundTestGuild(db, { name: 'ActivityA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'ActivityB', goal: 'g' })
  await new PgActivityLog(db, new MemoryKeyProvider()).record(a, input)
  expect(await db.withGuild(b, (tx) => tx`select member_id from member_activity`)).toHaveLength(0)
  expect(
    await db.withGuild(b, (tx) => tx`select seq from events where type = 'member.activity'`)
  ).toHaveLength(0)
  const forged = await db
    .withGuild(
      b,
      (tx) => tx`
        insert into member_activity (guild_id, member_id, activity, last_at)
        values (${a}, 'm-x', 'thinking', now())`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(forged).toContain('row-level security')
})
