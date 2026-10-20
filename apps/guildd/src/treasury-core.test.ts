import { expect, test } from 'bun:test'
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

test('the hash covers the acting member', () => {
  expect(entryHash('guild-a', body)).not.toBe(entryHash('guild-a', { ...body, actorMember: 'm1' }))
})
