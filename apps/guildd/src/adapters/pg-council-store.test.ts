import { afterAll, expect, test } from 'bun:test'
import { createDb } from '../db/client'
import { eventsAfter } from '../events'
import { councilStoreContract } from '../ports/council-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgCouncilStore } from './pg-council-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

councilStoreContract('postgres', async () => ({
  store: new PgCouncilStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Council', goal: 'g' }),
}))

test('convening, each vote and the escalation append one audit event each; a repeat appends none', async () => {
  const store = new PgCouncilStore(db, new MemoryKeyProvider())
  const g = await foundTestGuild(db, { name: 'Council events', goal: 'g' })
  const input = { questId: 'q1', proposalHash: 'c'.repeat(64), day: '2026-01-01', sessionCap: 5 }
  const opened = await store.open(g, input)
  await store.open(g, input)
  if (opened.status === 'cap_reached') {
    throw new Error('unexpected cap')
  }
  const id = opened.session.id
  const v = {
    reasons: ['secret reasons'],
    abstainCode: null,
    inputTokens: 1,
    outputTokens: 1,
    costMicros: 1,
  }
  await store.recordVote(g, id, { voice: 'architect', vote: 'approve', ...v })
  await store.recordVote(g, id, { voice: 'architect', vote: 'block', ...v })
  await store.escalate(g, id, 'approval_not_enabled')
  await store.escalate(g, id, 'approval_not_enabled')
  const events = (await db.withGuild(g, (tx) => eventsAfter(tx, 0, 100))).filter((e) =>
    e.type.startsWith('council.')
  )
  expect(events.map((e) => [e.type, e.payload])).toEqual([
    ['council.convened', { sessionId: id, questId: 'q1', proposalHash: input.proposalHash }],
    ['council.voted', { sessionId: id, voice: 'architect', vote: 'approve' }],
    [
      'council.escalated',
      {
        sessionId: id,
        questId: 'q1',
        proposalHash: input.proposalHash,
        reason: 'approval_not_enabled',
      },
    ],
  ])
})
