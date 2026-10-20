import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { createDb } from '../db/client'
import { DEFAULT_TREASURY } from '../guild-config'
import { treasuryStoreContract } from '../ports/treasury-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgTreasuryStore, SPENT_ON_SQL } from './pg-treasury-store'

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
    'memberId',
  ])
  for (const e of events) {
    expect(Object.keys(e.payload).every((k) => allowed.has(k))).toBe(true)
  }
  expect(JSON.stringify(events)).not.toContain('SECRET')
})

/** Writes the first ledger entries: opening the Treasury is a read, so only a write funds it. */
async function fund(g: string) {
  await store().recordRevenue(
    g,
    { key: 'fund', amountCents: 100, evidence: 'e', actorMember: 'm' },
    DEFAULT_TREASURY
  )
}

test('the ledger is append-only: the app role and the owner both fail to alter or remove an entry', async () => {
  const g = await newGuild()
  await fund(g)
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
  await fund(g)
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

interface PlanNode {
  'Relation Name'?: string | undefined
  'Actual Rows'?: number | undefined
  'Actual Loops'?: number | undefined
  'Rows Removed by Filter'?: number | undefined
  Plans?: PlanNode[] | undefined
}
const planNode: z.ZodType<PlanNode> = z.lazy(() =>
  z.object({
    'Relation Name': z.string().optional(),
    'Actual Rows': z.number().optional(),
    'Actual Loops': z.number().optional(),
    'Rows Removed by Filter': z.number().optional(),
    Plans: z.array(planNode).optional(),
  })
)
const planRows = z.array(z.object({ 'QUERY PLAN': z.array(z.object({ Plan: planNode })) }))

/** Rows the plan read from treasury_ledger: returned by loops plus rejected by filters. */
function ledgerRowsRead(node: PlanNode): number {
  const loops = node['Actual Loops'] ?? 1
  const own =
    node['Relation Name'] === 'treasury_ledger'
      ? ((node['Actual Rows'] ?? 0) + (node['Rows Removed by Filter'] ?? 0)) * loops
      : 0
  return own + (node.Plans ?? []).reduce((sum, child) => sum + ledgerRowsRead(child), 0)
}

test("the day-spend query reads only the day's reservations, however many old spends exist", async () => {
  const g = await newGuild()
  await fund(g)
  const zeros = '0'.repeat(64)
  const read = await owner.begin(async (tx) => {
    await tx`select set_config('app.guild_id', ${g}, true)`
    await tx`
      insert into treasury_spends
        (guild_id, spend_id, client_key, amount_cents, settled_cents, purpose, requested_by,
         status, approved_by, created_at)
      select ${g}, gen_random_uuid(), 'old-' || n, 500, 300, 'p', 'm', 'settled', 'treasurer',
             '2020-01-01'
      from generate_series(1, 20000) n`
    await tx`
      insert into treasury_ledger
        (guild_id, seq, entry_id, kind, bucket, amount_cents, spend_id, day, created_at,
         prev_hash, hash)
      select ${g}, 1000 + row_number() over (), gen_random_uuid(), k.kind, 'operating', k.amount,
             s.spend_id, '2020-01-01', '2020-01-01', ${zeros}, ${zeros}
      from treasury_spends s
      cross join (values ('spend_reserve', -500), ('spend_settle', 200)) as k(kind, amount)
      where s.guild_id = ${g}`
    await tx`analyze treasury_ledger`
    const rows = await tx.unsafe(`explain (analyze, format json) ${SPENT_ON_SQL}`, [
      g,
      '2030-01-01',
    ])
    return ledgerRowsRead(planRows.parse(rows)[0]?.['QUERY PLAN'][0]?.Plan ?? {})
  })
  expect(read).toBeLessThan(500)
})
