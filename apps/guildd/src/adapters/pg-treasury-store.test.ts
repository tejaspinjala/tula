import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { DEFAULT_TREASURY } from '../guild-config'
import { treasuryStoreContract } from '../ports/treasury-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgTreasuryStore } from './pg-treasury-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
const keys = new MemoryKeyProvider()
afterAll(async () => {
  await db.close()
  await owner.end()
})

const newGuild = () => foundTestGuild(db, { name: 'Treasury', goal: 'g' }, keys)

treasuryStoreContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T12:00:00.000Z'))
  return {
    store: new PgTreasuryStore(db, keys, clock),
    newGuild,
    advanceMs: (ms: number) => clock.advance(ms),
    tamper: async (guildId: string, seq: number, amountCents: number) => {
      // The ledger is append-only for everyone, owner included; a hostile DBA first has to
      // switch the trigger off, which is exactly the attack the hash chain exists to expose.
      await owner.begin(async (tx) => {
        await tx`select set_config('app.guild_id', ${guildId}, true)`
        await tx`alter table treasury_ledger disable trigger treasury_ledger_append_only`
        await tx`update treasury_ledger set amount_cents = ${amountCents}
                 where guild_id = ${guildId} and seq = ${seq}`
        await tx`alter table treasury_ledger enable trigger treasury_ledger_append_only`
      })
    },
  }
})

const store = () =>
  new PgTreasuryStore(db, keys, new MemoryClock(new Date('2030-01-01T12:00:00.000Z')))

test('Treasury events carry ids and amounts only, never evidence or purpose text', async () => {
  const g = await newGuild()
  const s = store()
  await s.recordRevenue(
    g,
    { actorMember: 'member-1', key: 'r', amountCents: 1000, evidence: 'SECRET-EVIDENCE invoice' },
    DEFAULT_TREASURY
  )
  await s.requestSpend(
    g,
    { key: 'k', amountCents: 100, purpose: 'SECRET-PURPOSE ads', requestedBy: 'treasurer' },
    DEFAULT_TREASURY
  )
  const events = await owner`
    select type, payload from events where guild_id = ${g} and type like 'treasury.%' order by seq`
  expect(events.length).toBeGreaterThan(0)
  const allowed = new Set([
    'entryId',
    'seq',
    'kind',
    'bucket',
    'amountCents',
    'hash',
    'spendId',
    'status',
  ])
  for (const e of events) {
    expect(Object.keys(e.payload).every((k) => allowed.has(k))).toBe(true)
  }
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

test('the ledger is append-only: the app role and the owner both fail to alter or remove an entry', async () => {
  const g = await newGuild()
  await store().snapshot(g, DEFAULT_TREASURY)
  await expect(
    db.withGuild(g, (tx) => tx`update treasury_ledger set amount_cents = 1 where guild_id = ${g}`)
  ).rejects.toThrow()
  await expect(
    db.withGuild(g, (tx) => tx`delete from treasury_ledger where guild_id = ${g}`)
  ).rejects.toThrow()
  await expect(
    owner.begin(async (tx) => {
      await tx`select set_config('app.guild_id', ${g}, true)`
      await tx`update treasury_ledger set amount_cents = 1 where guild_id = ${g}`
    })
  ).rejects.toThrow(/append-only/)
  await expect(
    owner.begin(async (tx) => {
      await tx`select set_config('app.guild_id', ${g}, true)`
      await tx`truncate treasury_ledger`
    })
  ).rejects.toThrow(/append-only/)
})

test('the database refuses revenue without evidence and a non-paper entry', async () => {
  const g = await newGuild()
  await store().snapshot(g, DEFAULT_TREASURY)
  const insert = (kind: string, evidence: string | null, mode: string) =>
    db.withGuild(
      g,
      (tx) => tx`
        insert into treasury_ledger
          (guild_id, seq, entry_id, kind, bucket, amount_cents, mode, evidence, day, created_at,
           prev_hash, hash)
        values (${g}, 99, gen_random_uuid(), ${kind}, 'profit', 5, ${mode}, ${evidence},
                '2030-01-01', now(), ${'0'.repeat(64)}, ${'1'.repeat(64)})`
    )
  await expect(insert('revenue', null, 'paper')).rejects.toThrow()
  await expect(insert('revenue', '  ', 'paper')).rejects.toThrow()
  await expect(insert('revenue', 'invoice', 'real')).rejects.toThrow()
})
