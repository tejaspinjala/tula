import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb, type Db } from '../db/client'
import { hashProposal, SEAL_TTL_MS } from '../ports/seal-store'
import { sealStoreContract } from '../ports/seal-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgSealStore } from './pg-seal-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const start = new Date('2026-01-01T00:00:00.000Z')

sealStoreContract('postgres', async () => {
  const clock = new MemoryClock(start)
  return {
    store: new PgSealStore(db, new MemoryKeyProvider(), clock),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Seals', goal: 'g' }),
  }
})

async function setup() {
  const clock = new MemoryClock(start)
  const guild = await foundTestGuild(db, { name: 'Seals', goal: 'g' })
  const store = new PgSealStore(db, new MemoryKeyProvider(), clock)
  const text = 'secret-proposal-text'
  const hash = await hashProposal(text)
  const seal = await store.request(guild, {
    questId: crypto.randomUUID(),
    requestedBy: 'herald-1',
    kind: 'post',
    text,
    evidence: 'secret-evidence',
  })
  return { clock, guild, store, seal, hash }
}

test('seal events carry ids and hashes only, never the text or evidence', async () => {
  const { guild, store, seal, hash } = await setup()
  await store.decide(guild, seal.id, { verdict: 'approved', expectedHash: hash, note: 'private' })
  await store.markPosted(guild, seal.id, 'secret-proposal-text')
  const events = await owner`
    select type, payload from events where guild_id = ${guild} and type ~ '^(seal|post)\\.' order by seq`
  expect(events.map((e) => e.type)).toEqual([
    'seal.requested',
    'seal.approved',
    'seal.consumed',
    'post.published_manually',
  ])
  const json = JSON.stringify(events)
  expect(json).toContain(hash)
  for (const secret of ['secret-proposal-text', 'secret-evidence', 'private']) {
    expect(json).not.toContain(secret)
  }
})

test('the database refuses to change a decided Seal, even as owner', async () => {
  const { guild, store, seal, hash } = await setup()
  await store.decide(guild, seal.id, { verdict: 'denied', expectedHash: hash })
  const flip = (sql: string) =>
    owner
      .unsafe(`update seals set ${sql} where guild_id = '${guild}' and seal_id = '${seal.id}'`)
      .then(
        () => 'ok',
        (e: Error) => e.message
      )
  expect(await flip(`status = 'approved'`)).toContain('not allowed')
  expect(await flip(`decision_note = 'changed'`)).toContain('not allowed')
  expect(await flip(`action_hash = '${'a'.repeat(64)}'`)).toContain('immutable')
  expect((await store.get(guild, seal.id))?.status).toBe('denied')
})

test('a decision cannot be rewritten after approval either', async () => {
  const { guild, store, seal, hash } = await setup()
  await store.decide(guild, seal.id, { verdict: 'approved', expectedHash: hash })
  await store.reserve(guild, seal.id, 'secret-proposal-text')
  const message = await owner
    .unsafe(
      `update seals set status = 'released', reservation_token_hash = null, decided_at = now() where guild_id = '${guild}' and seal_id = '${seal.id}'`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(message).toContain('decision is made once')
})

test('expiry is persisted as an event once', async () => {
  const { clock, guild, store } = await setup()
  clock.advance(SEAL_TTL_MS)
  expect(await store.expireDue(guild)).toBe(1)
  const events = await owner`
    select type from events where guild_id = ${guild} and type = 'seal.expired'`
  expect(events).toHaveLength(1)
})

test('the database refuses a sealed hash that is not the hash of the text', async () => {
  const { guild } = await setup()
  const message = await owner
    .unsafe(
      `insert into seals (guild_id, quest_id, requested_by, kind, text, evidence, action_hash,
        requested_at, expires_at)
       values ('${guild}', gen_random_uuid(), 'a', 'post', 'real text', 'e', '${'b'.repeat(64)}',
        now(), now() + interval '1 day')`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(message).toContain('seals_action_hash_binds_text')
})

test('listing a rare status among many Seals is one query', async () => {
  let queries = 0
  const counting: Db = {
    ...db,
    withGuild: (g, fn) =>
      db.withGuild(g, (tx) =>
        fn(
          new Proxy(tx, {
            apply: (target, thisArg, args) => {
              if (String(args[0]).includes('from seals')) {
                queries++
              }
              return Reflect.apply(target, thisArg, args)
            },
          })
        )
      ),
  }
  const guild = await foundTestGuild(db, { name: 'Seals', goal: 'g' })
  const store = new PgSealStore(counting, new MemoryKeyProvider(), new MemoryClock(start))
  for (let i = 0; i < 12; i++) {
    await store.request(guild, {
      questId: crypto.randomUUID(),
      requestedBy: 'h',
      kind: 'post',
      text: `post ${i}`,
      evidence: 'e',
    })
  }
  const [one] = (await store.list(guild, { limit: 1 })).seals
  await store.decide(guild, one?.id ?? '', {
    verdict: 'denied',
    expectedHash: one?.actionHash ?? '',
  })
  queries = 0
  const page = await store.list(guild, { limit: 1, status: 'denied' })
  expect(page.seals).toHaveLength(1)
  expect(queries).toBe(1)
})
