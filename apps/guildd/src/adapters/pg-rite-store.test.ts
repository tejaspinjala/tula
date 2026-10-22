import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { riteStoreContract } from '../ports/rite-store.contract'
import { RITE_EVENT, RITE_EVENT_PREFIX } from '../rites/events'
import { LEARNING_TO_LINKEDIN } from '../rites/templates'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgRiteStore } from './pg-rite-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
const newGuild = () => foundTestGuild(db, { name: 'Rites', goal: 'g' })
const make = () => new PgRiteStore(db, new MemoryKeyProvider(), clock)

riteStoreContract('postgres', async () => ({ store: make(), newGuild }))

const refused = (sql: string) =>
  owner.unsafe(sql).then(
    () => 'ok',
    (e: Error) => e.message
  )

const input = (status: 'active' | 'pending' = 'active') => ({
  name: 'Secret flow',
  graph: structuredClone(LEARNING_TO_LINKEDIN),
  classification: status === 'active' ? ('internal' as const) : ('widening' as const),
  status,
})

test('events carry ids and small facts only, never the graph', async () => {
  const guild = await newGuild()
  const store = make()
  await store.saveVersion(guild, 'wf', input('pending'))
  await store.activate(guild, 'wf', 1)
  await store.createInstance(guild, { riteId: 'wf', version: 1, runKey: 'k' })
  await store.createInstance(guild, { riteId: 'wf', version: 1, runKey: 'k' })
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type like ${RITE_EVENT_PREFIX + '%'} order by seq`
  expect(events.map((e) => e.type)).toEqual([
    RITE_EVENT.versionSaved,
    RITE_EVENT.versionConfirmed,
    RITE_EVENT.runStarted,
  ])
  expect(JSON.stringify(events)).not.toContain('briefTemplate')
})

test('the database freezes versions except the pending to active move, and refuses deletes', async () => {
  const guild = await newGuild()
  const store = make()
  await store.saveVersion(guild, 'wf', input('pending'))
  await store.createInstance(guild, { riteId: 'wf', version: 1, runKey: 'k' })
  expect(
    await refused(`update workflow_versions set graph = '{}'::jsonb where guild_id = '${guild}'`)
  ).toContain('immutable')
  expect(
    await refused(`update workflow_versions set name = 'x' where guild_id = '${guild}'`)
  ).toContain('immutable')
  expect(await refused(`delete from workflow_versions where guild_id = '${guild}'`)).toContain(
    'immutable'
  )
  expect(await refused(`delete from workflow_instances where guild_id = '${guild}'`)).toContain(
    'immutable'
  )
  expect(
    await refused(
      `update workflow_versions set status = 'active' where guild_id = '${guild}' and version = 1`
    )
  ).toBe('ok')
  expect(
    await refused(
      `update workflow_versions set status = 'pending' where guild_id = '${guild}' and version = 1`
    )
  ).toContain('immutable')
})

test('a publish writes the published event, and a stale one writes nothing', async () => {
  const guild = await newGuild()
  const store = make()
  await store.saveVersion(guild, 'wf', input())
  await store.saveVersion(guild, 'wf', { ...input(), status: 'draft' })
  await store.publishDraft(guild, 'wf', {
    version: 2,
    basedOn: 9,
    classifiedAgainst: 9,
    outcome: 'active',
  })
  await store.publishDraft(guild, 'wf', {
    version: 2,
    basedOn: 1,
    classifiedAgainst: 1,
    outcome: 'active',
  })
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type = ${RITE_EVENT.versionPublished}`
  expect(events.map((e) => e.payload)).toMatchObject([
    { riteId: 'wf', version: 2, status: 'active' },
  ])
  expect(
    await refused(
      `update workflow_versions set status = 'draft' where guild_id = '${guild}' and version = 2`
    )
  ).toContain('immutable')
})

test('based_on is frozen once a version leaves draft, and a pending row with no base is stale over an active one', async () => {
  const guild = await newGuild()
  const store = make()
  await store.saveVersion(guild, 'wf', input())
  await store.saveVersion(guild, 'wf', { ...input('pending'), status: 'pending' })
  expect(
    await refused(
      `update workflow_versions set based_on = 1 where guild_id = '${guild}' and version = 2`
    )
  ).toContain('immutable')
  expect(
    await refused(
      `update workflow_versions set based_on = 1 where guild_id = '${guild}' and version = 1`
    )
  ).toContain('immutable')
  expect(await store.activate(guild, 'wf', 2)).toEqual({ ok: false, error: 'stale' })
})

test('archive and unarchive append their events in the same transaction, only when they change something', async () => {
  const guild = await newGuild()
  const store = make()
  await store.saveVersion(guild, 'wf', input())
  await store.archive(guild, 'wf')
  await store.archive(guild, 'wf')
  await store.unarchive(guild, 'wf')
  await store.unarchive(guild, 'wf')
  const events = await owner`
    select type, payload from events where guild_id = ${guild}
      and type in (${RITE_EVENT.archived}, ${RITE_EVENT.unarchived}) order by seq`
  expect(events.map((e) => e.type)).toEqual([RITE_EVENT.archived, RITE_EVENT.unarchived])
  expect(events[1]?.payload).toMatchObject({ riteId: 'wf', superseded: 1 })
})
