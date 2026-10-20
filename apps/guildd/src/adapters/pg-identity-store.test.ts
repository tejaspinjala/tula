import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { MAX_OUTSTANDING_CHALLENGES } from '../ports/identity'
import { testDbUrl } from '../testing/test-db'
import type { StoredChallenge } from './identity-store'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgIdentityStore } from './pg-identity-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const store = new PgIdentityStore(db, new MemoryKeyProvider())
const T0 = new Date('2026-01-01T00:00:00.000Z')

function challenge(offsetMs: number): StoredChallenge {
  return {
    id: crypto.randomUUID(),
    kind: 'signin',
    challenge: 'c',
    sessionId: null,
    foundingHash: null,
    expiresAt: new Date(T0.getTime() + offsetMs),
  }
}

async function rows(guildId: string): Promise<number> {
  const [row] =
    await owner`select count(*)::int as n from identity_challenges where guild_id = ${guildId}`
  return Number(row?.n)
}

test("saving a challenge deletes the guild's expired ones", async () => {
  const guildId = await db.foundGuild({ name: 'Sweep', goal: 'g' })
  await store.saveChallenge(guildId, challenge(1000), T0)
  await store.saveChallenge(guildId, challenge(2000), T0)
  expect(await rows(guildId)).toBe(2)
  await store.saveChallenge(guildId, challenge(60_000), new Date(T0.getTime() + 5000))
  expect(await rows(guildId)).toBe(1)
})

test('outstanding challenges per guild are capped, keeping the newest', async () => {
  const guildId = await db.foundGuild({ name: 'Cap', goal: 'g' })
  const oldest = challenge(10_000)
  await store.saveChallenge(guildId, oldest, T0)
  for (let i = 1; i <= MAX_OUTSTANDING_CHALLENGES; i++) {
    await store.saveChallenge(guildId, challenge(10_000 + i), T0)
  }
  expect(await rows(guildId)).toBe(MAX_OUTSTANDING_CHALLENGES)
  expect(await store.takeChallenge(guildId, oldest.id)).toBeNull()
})
