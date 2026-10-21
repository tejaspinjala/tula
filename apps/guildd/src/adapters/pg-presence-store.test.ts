import { afterAll, expect, test } from 'bun:test'
import { createDb } from '../db/client'
import { eventsAfter } from '../events'
import { presenceStoreContract } from '../ports/presence-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgPresenceStore } from './pg-presence-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

const start = new Date('2026-01-01T00:00:00.000Z')

presenceStoreContract('postgres', async () => {
  const clock = new MemoryClock(start)
  return {
    store: new PgPresenceStore(db, new MemoryKeyProvider(), clock),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Presence', goal: 'g' }),
  }
})

test('each change appends exactly one audit event; a no-op return appends none', async () => {
  const clock = new MemoryClock(start)
  const store = new PgPresenceStore(db, new MemoryKeyProvider(), clock)
  const g = await foundTestGuild(db, { name: 'Presence events', goal: 'g' })
  const until = new Date(start.getTime() + 3_600_000).toISOString()
  await store.returnHome(g)
  await store.goAway(g, until)
  await store.returnHome(g)
  await store.returnHome(g)
  const events = (await db.withGuild(g, (tx) => eventsAfter(tx, 0, 100))).filter((e) =>
    e.type.startsWith('guildmaster.')
  )
  expect(events.map((e) => [e.type, e.payload])).toEqual([
    ['guildmaster.away', { since: start.toISOString(), until }],
    ['guildmaster.returned', { since: start.toISOString() }],
  ])
})
