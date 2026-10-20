import { afterAll, expect, test } from 'bun:test'
import { createDb } from '../db/client'
import { eventsAfter } from '../events'
import { modelLedgerContract } from '../ports/model-ledger.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgModelLedger } from './pg-model-ledger'

const db = createDb(testDbUrl('app'))
const keys = new MemoryKeyProvider()
afterAll(async () => {
  await db.close()
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
