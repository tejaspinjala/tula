import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import type { NewInquiry } from '../ports/inquiry-store'
import { inquiryStoreContract } from '../ports/inquiry-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgInquiryStore } from './pg-inquiry-store'
import { PgQuestQueue } from './pg-quest-queue'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const T0 = new Date('2026-01-01T00:00:00.000Z')

function build() {
  const keys = new MemoryKeyProvider()
  const quests = new PgQuestQueue(db, keys, new MemoryClock(T0), () => 0.5)
  return { quests, store: new PgInquiryStore(db, keys, quests) }
}

inquiryStoreContract('postgres', async () => ({
  ...build(),
  newGuild: () => foundTestGuild(db, { name: 'Inquiries', goal: 'g' }),
}))

function ask(over: Partial<NewInquiry> = {}): NewInquiry {
  const id = crypto.randomUUID()
  return {
    id,
    fromHall: 'heralds',
    toHall: 'scribes',
    askQuestId: crypto.randomUUID(),
    attempt: 1,
    asker: 'heralds-member-2',
    question: 'SECRET-QUESTION about tone',
    maxPerQuest: 3,
    at: T0,
    expiresAt: new Date(T0.getTime() + 86_400_000),
    answerQuest: {
      jobKey: `inquiry:${id}`,
      templateId: 'inquiry-answer',
      hallId: 'scribes',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'Answer an Inquiry',
      ownerId: 'scribes-captain',
      doneCondition: `Answer Inquiry ${id}`,
      roundLimit: 2,
    },
    ...over,
  }
}

test('ask, answer and expiry each append one audit event with ids only, never the text', async () => {
  const guild = await foundTestGuild(db, { name: 'Inquiries', goal: 'g' })
  const { store } = build()
  const first = await store.ask(guild, ask())
  const second = await store.ask(guild, ask({ question: 'another' }))
  if (!first.ok || !second.ok) {
    throw new Error('ask refused')
  }
  await store.answer(guild, {
    inquiryId: first.inquiry.id,
    answerQuestId: first.answerQuest.id,
    by: 'scribes-captain',
    answer: 'SECRET-ANSWER',
    at: T0,
  })
  await store.expireOverdue(guild, new Date(T0.getTime() + 2 * 86_400_000))
  const events = await owner`
    select type, payload from events
    where guild_id = ${guild} and type like 'inquiry.%' order by seq`
  expect(events.map((e) => e.type)).toEqual([
    'inquiry.asked',
    'inquiry.asked',
    'inquiry.answered',
    'inquiry.expired',
  ])
  expect(events[0]?.payload).toMatchObject({ fromHall: 'heralds', toHall: 'scribes' })
  expect(JSON.stringify(events)).not.toContain('SECRET')
  const chained = await owner`
    select count(*)::int as n from audit_chain where guild_id = ${guild}`
  expect(Number(chained[0]?.n)).toBeGreaterThanOrEqual(4)
})

test('a refused ask leaves neither an Inquiry nor a Quest behind', async () => {
  const guild = await foundTestGuild(db, { name: 'Inquiries', goal: 'g' })
  const { store, quests } = build()
  const bad = ask({ answerQuest: { ...ask().answerQuest, blockedBy: [crypto.randomUUID()] } })
  await expect(store.ask(guild, bad)).rejects.toThrow()
  expect((await store.list(guild, { hallId: 'heralds', limit: 10 })).inquiries).toEqual([])
  expect((await quests.list(guild, { limit: 10 })).quests).toEqual([])
})

test('a cross-guild read sees no row of another guild, and a forged insert is refused', async () => {
  const a = await foundTestGuild(db, { name: 'InquiriesA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'InquiriesB', goal: 'g' })
  await build().store.ask(a, ask())
  const seen = await db.withGuild(b, (tx) => tx`select inquiry_id from inquiries`)
  expect(seen.length).toBe(0)
  const forged = await db
    .withGuild(
      b,
      (tx) => tx`
        insert into inquiries (guild_id, inquiry_id, from_hall, to_hall, ask_quest_id,
          answer_quest_id, asker, question, asked_at, expires_at, dedupe_key)
        values (${a}, ${crypto.randomUUID()}, 'h', 'g', ${crypto.randomUUID()},
          ${crypto.randomUUID()}, 'x', 'forged', now(), now(), 'k')`
    )
    .then(
      () => 'ok',
      (e: Error) => e.message
    )
  expect(forged).toContain('row-level security')
})
