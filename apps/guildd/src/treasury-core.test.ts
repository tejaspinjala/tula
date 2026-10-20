import { expect, test } from 'bun:test'
import { MemoryTreasuryStore } from './adapters/memory-treasury-store'
import { DEFAULT_TREASURY } from './guild-config'
import type { Clock } from './ports/clock'
import type { LedgerEntry } from './ports/treasury-store'
import { entryHash } from './treasury-core'

const body: Omit<LedgerEntry, 'hash'> = {
  seq: 1,
  id: '00000000-0000-4000-8000-000000000001',
  kind: 'seed',
  bucket: 'operating',
  amountCents: 7000,
  mode: 'paper',
  spendId: null,
  idemKey: 'seed',
  actorMember: null,
  evidence: null,
  day: '2030-01-01',
  createdAt: '2030-01-01T00:00:00.000Z',
  prevHash: '0'.repeat(64),
}

test('the same entry body hashes differently for two guilds', () => {
  expect(entryHash('guild-a', body)).not.toBe(entryHash('guild-b', body))
})

test('one operation reads the clock once: a tick across midnight cannot split its check from its entries', async () => {
  let at = Date.parse('2030-01-01T23:59:59.000Z')
  const ticking: Clock = {
    now: () => {
      const d = new Date(at)
      at += 400
      return d
    },
  }
  const store = new MemoryTreasuryStore(ticking)
  const guild = crypto.randomUUID()
  const result = await store.requestSpend(
    guild,
    { key: 'k', amountCents: 400, purpose: 'p', requestedBy: 'm' },
    DEFAULT_TREASURY
  )
  expect(result).toMatchObject({ ok: true, spend: { status: 'reserved' } })
  const entries = (await store.listEntries(guild, { limit: 100 })).items
  expect(entries).toHaveLength(3)
  expect(new Set(entries.map((e) => e.day))).toEqual(new Set(['2030-01-01']))
  expect(new Set(entries.map((e) => e.createdAt)).size).toBe(1)
})

test('the hash covers the acting member', () => {
  expect(entryHash('guild-a', body)).not.toBe(entryHash('guild-a', { ...body, actorMember: 'm1' }))
})
