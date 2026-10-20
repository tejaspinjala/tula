import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { WHOLE_HALL } from '../ports/missive-store'
import { missiveStoreContract } from '../ports/missive-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgMissiveStore } from './pg-missive-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

missiveStoreContract('postgres', async () => ({
  store: new PgMissiveStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Missives', goal: 'g' }),
}))

function send(text: string) {
  return {
    hallId: 'h-forge',
    questId: crypto.randomUUID(),
    attempt: 1,
    from: 'm-ada',
    to: WHOLE_HALL,
    text,
    maxPerQuest: 5,
    at: new Date(),
  }
}

test('a send appends missive.sent with ids only, never any of the text', async () => {
  const guild = await foundTestGuild(db, { name: 'Missives', goal: 'g' })
  const store = new PgMissiveStore(db, new MemoryKeyProvider())
  const sent = await store.send(guild, send('SECRET-WORDS and more'))
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type = 'missive.sent'`
  expect(events).toHaveLength(1)
  const payload = events[0]?.payload
  expect(Object.keys(payload).sort()).toEqual(['from', 'hall', 'missiveId', 'to'])
  expect(payload).toMatchObject({
    missiveId: sent.ok ? sent.missive.id : '',
    from: 'm-ada',
    to: WHOLE_HALL,
    hall: 'h-forge',
  })
  expect(JSON.stringify(events)).not.toContain('SECRET-WORDS')
})

test('a repeated send appends one event only', async () => {
  const guild = await foundTestGuild(db, { name: 'Missives', goal: 'g' })
  const store = new PgMissiveStore(db, new MemoryKeyProvider())
  const input = send('once')
  await store.send(guild, input)
  await store.send(guild, input)
  const events = await owner`
    select type from events where guild_id = ${guild} and type = 'missive.sent'`
  expect(events).toHaveLength(1)
})

test('a cross-guild read through the app role sees no row of another guild, and a forged insert is refused', async () => {
  const a = await foundTestGuild(db, { name: 'MissivesA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'MissivesB', goal: 'g' })
  const store = new PgMissiveStore(db, new MemoryKeyProvider())
  await store.send(a, send('private to A'))
  const seen = await db.withGuild(b, (tx) => tx`select missive_id from missives`)
  expect(seen.length).toBe(0)
  const forged = await db
    .withGuild(
      b,
      (tx) => tx`
        insert into missives (guild_id, hall_id, quest_id, sender, addressee, body, sent_at, dedupe_key)
        values (${a}, 'h-forge', ${crypto.randomUUID()}, 'm-x', 'hall', 'forged', now(), 'k')`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(forged).toContain('row-level security')
})
