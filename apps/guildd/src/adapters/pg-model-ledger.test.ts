import { afterAll, expect, test } from 'bun:test'
import { createDb } from '../db/client'
import { eventsAfter } from '../events'
import { modelLedgerContract } from '../ports/model-ledger.contract'
import { foundTestGuild } from '../testing/found-guild'
import { createIsolatedTestDb, testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgModelLedger } from './pg-model-ledger'

// Global bars and revokes reach every guild of a database, so this file gets its own.
const isolated = await createIsolatedTestDb()
const db = createDb(testDbUrl('app', isolated.name))
const keys = new MemoryKeyProvider()
afterAll(async () => {
  await db.close()
  await isolated.drop()
})

modelLedgerContract('postgres', async () => ({
  ledger: new PgModelLedger(db, keys),
  newGuild: () => foundTestGuild(db, { name: 'Gateway', goal: 'g' }, keys),
}))

test('the cap notice appends exactly one steward.cap_reached event per guild-day', async () => {
  const ledger = new PgModelLedger(db, keys)
  const g = await foundTestGuild(db, { name: 'Gateway events', goal: 'g' }, keys)
  await Promise.all([
    ledger.noteCapReached(g, '2026-03-04', 'daily_spend'),
    ledger.noteCapReached(g, '2026-03-04', 'daily_spend'),
  ])
  const events = await db.withGuild(g, (tx) => eventsAfter(tx, 0, 100))
  const notices = events.filter((e) => e.type === 'steward.cap_reached')
  expect(notices).toHaveLength(1)
  expect(notices[0]?.payload).toEqual({ day: '2026-03-04', reason: 'daily_spend' })
})

test('the app role can settle a pending charge once, and cannot rewrite anything else', async () => {
  const ledger = new PgModelLedger(db, keys)
  const g = await foundTestGuild(db, { name: 'Gateway immutability', goal: 'g' }, keys)
  await ledger.openRun(g, {
    runId: 'r1',
    questId: 'quest-1',
    attempt: 1,
    hallId: 'heralds',
    providerId: 'cloud',
    profileId: 'cloud-mid',
    state: 'active',
    tokenHash: 'h',
    expiresAt: '2026-03-04T12:00:00.000Z',
  })
  await ledger.reserve(g, {
    callKey: 'c1',
    runId: 'r1',
    day: '2026-03-04',
    inputTokens: 10,
    outputTokens: 5,
    costMicros: 100,
    clientKey: null,
    caps: { tokens: 1_000_000, costMicros: 1_000_000 },
  })
  const rewrite = (column: string, value: string) =>
    db.withGuild(
      g,
      (tx) => tx`update model_usage set ${tx(column)} = ${value} where call_key = 'c1'`
    )
  await expect(rewrite('run_id', 'r2')).rejects.toThrow()
  await expect(rewrite('day', '2026-03-05')).rejects.toThrow()
  await expect(rewrite('call_key', 'c9')).rejects.toThrow()
  await expect(rewrite('client_key', 'k')).rejects.toThrow()
  await ledger.settle(g, 'c1', { inputTokens: 8, outputTokens: 4, costMicros: 80 })
  await expect(rewrite('state', 'pending')).rejects.toThrow()
  await expect(
    db.withGuild(g, (tx) => tx`update model_usage set output_tokens = 0 where call_key = 'c1'`)
  ).rejects.toThrow()
  // A retried settle of an already settled charge changes nothing and does not fail.
  await ledger.settle(g, 'c1', { inputTokens: 1, outputTokens: 1, costMicros: 1 })
  expect((await ledger.dayTotals(g, '2026-03-04')).tokens).toBe(12)
})
