import { afterAll, expect, test } from 'bun:test'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryKeyProvider } from './adapters/memory-key-provider'
import { PgAwaitingSealReader } from './adapters/pg-awaiting-seal-reader'
import { PgQuestQueue } from './adapters/pg-quest-queue'
import { PgSealStore } from './adapters/pg-seal-store'
import { reconcileSeals } from './core-loop'
import { createDb } from './db/client'
import { foundTestGuild } from './testing/found-guild'
import { testDbUrl } from './testing/test-db'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

async function setup(roundLimit: number) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  const quests = new PgQuestQueue(db, keys, clock, () => 0.5)
  const seals = new PgSealStore(db, keys, clock)
  const guild = await foundTestGuild(db, { name: 'Loop', goal: 'g' })
  const { quest } = await quests.post(guild, {
    jobKey: 'k',
    templateId: 'herald-announcement',
    hallId: 'heralds',
    rank: 'apprentice',
    dataClass: 'public',
    title: 'Announce',
    ownerId: 'heralds-member-1',
    doneCondition: 'An announcement draft is ready for a Seal',
    roundLimit,
  })
  const claimed = await quests.claim(guild, { leaseMs: 60_000, maxActive: 5 })
  await quests.submitForSeal(guild, quest.id, claimed?.attempts ?? 0)
  const ask = (round: number) =>
    seals.request(guild, {
      questId: quest.id,
      requestedBy: 'heralds-member-1',
      kind: 'post',
      text: 'Hello',
      evidence: 'verdict: pass',
      round,
    })
  return {
    quests,
    seals,
    guild,
    quest,
    ask,
    deps: { quests, seals, awaiting: new PgAwaitingSealReader(db, clock) },
  }
}

test('reconcileSeals on Postgres: a posted Seal finishes the Quest, once', async () => {
  const s = await setup(2)
  const seal = await s.ask(1)
  expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
  await s.seals.decide(s.guild, seal.id, { verdict: 'approved', expectedHash: seal.actionHash })
  await s.seals.markPosted(s.guild, seal.id, 'Hello', { reauthenticated: true })
  expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(1)
  expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('done')
  expect((await reconcileSeals(s.deps, s.guild)).settled).toBe(0)
})

test('reconcileSeals on Postgres: a denied Seal on the last round dead-letters the Quest', async () => {
  const s = await setup(1)
  const seal = await s.ask(1)
  await s.seals.decide(s.guild, seal.id, { verdict: 'denied', expectedHash: seal.actionHash })
  await reconcileSeals(s.deps, s.guild)
  const dead = await s.quests.get(s.guild, s.quest.id)
  expect([dead?.state, dead?.lastError]).toEqual(['dead', 'seal_rejected'])
})

test('reconcileSeals on Postgres: a denied Seal with rounds left queues a revision', async () => {
  const s = await setup(2)
  const seal = await s.ask(1)
  await s.seals.decide(s.guild, seal.id, { verdict: 'denied', expectedHash: seal.actionHash })
  await reconcileSeals(s.deps, s.guild)
  expect((await s.quests.get(s.guild, s.quest.id))?.state).toBe('queued')
})
