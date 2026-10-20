import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { MAX_OUTSTANDING_CHALLENGES } from '../ports/identity'
import { foundTestGuild } from '../testing/found-guild'
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
  const guildId = await foundTestGuild(db, { name: 'Sweep', goal: 'g' })
  await store.saveChallenge(guildId, challenge(1000), T0)
  await store.saveChallenge(guildId, challenge(2000), T0)
  expect(await rows(guildId)).toBe(2)
  await store.saveChallenge(guildId, challenge(60_000), new Date(T0.getTime() + 5000))
  expect(await rows(guildId)).toBe(1)
})

test('outstanding challenges per guild are capped, keeping the newest', async () => {
  const guildId = await foundTestGuild(db, { name: 'Cap', goal: 'g' })
  const oldest = challenge(10_000)
  await store.saveChallenge(guildId, oldest, T0)
  for (let i = 1; i <= MAX_OUTSTANDING_CHALLENGES; i++) {
    await store.saveChallenge(guildId, challenge(10_000 + i), T0)
  }
  expect(await rows(guildId)).toBe(MAX_OUTSTANDING_CHALLENGES)
  expect(await store.takeChallenge(guildId, oldest.id)).toBeNull()
})

class DownKeys extends MemoryKeyProvider {
  override macFor(): Promise<never> {
    return Promise.reject(new Error('keys down'))
  }
}

const down = new PgIdentityStore(db, new DownKeys())
const note = { type: 'identity.test', payload: {} }
const cred = { id: 'cred-1', publicKey: new Uint8Array(4), counter: 0, transports: [] }

async function count(guildId: string, table: string): Promise<number> {
  const [row] =
    await owner`select count(*)::int as n from ${owner(table)} where guild_id = ${guildId}`
  return Number(row?.n)
}

test('a failing event append rolls back saveSession, setReauth, issueFounding and foundCredential', async () => {
  const guildId = await foundTestGuild(db, { name: 'Atomic', goal: 'g' })
  const session = {
    id: crypto.randomUUID(),
    tokenHash: 'th',
    expiresAt: new Date(T0.getTime() + 60_000),
    reauthHash: null,
    reauthExpiresAt: null,
  }
  const events0 = await count(guildId, 'events')
  await expect(down.saveSession(guildId, session, note)).rejects.toThrow('keys down')
  expect(await count(guildId, 'identity_sessions')).toBe(0)
  expect(await count(guildId, 'events')).toBe(events0)

  await store.saveSession(guildId, session, note)
  const events1 = await count(guildId, 'events')
  await expect(
    down.setReauth(guildId, session.id, 'rh', new Date(T0.getTime() + 1000), note)
  ).rejects.toThrow('keys down')
  const [row] = await owner`select reauth_hash from identity_sessions where guild_id = ${guildId}`
  expect(row?.reauth_hash).toBeNull()
  expect(await count(guildId, 'events')).toBe(events1)

  await expect(
    down.issueFounding(guildId, 'fh', new Date(T0.getTime() + 1000), note)
  ).rejects.toThrow('keys down')
  expect(await count(guildId, 'identity_founding')).toBe(0)
  expect(await count(guildId, 'events')).toBe(events1)

  await store.issueFounding(guildId, 'fh', new Date(T0.getTime() + 60_000), note)
  const events2 = await count(guildId, 'events')
  await expect(down.foundCredential(guildId, cred, 'fh', T0, [note])).rejects.toThrow('keys down')
  expect(await count(guildId, 'identity_credentials')).toBe(0)
  expect(await count(guildId, 'identity_founding')).toBe(1)
  expect(await count(guildId, 'events')).toBe(events2)
})

test('setReauth for an unknown session appends no event', async () => {
  const guildId = await foundTestGuild(db, { name: 'NoSession', goal: 'g' })
  const before = await count(guildId, 'events')
  await expect(
    store.setReauth(guildId, crypto.randomUUID(), 'rh', new Date(T0.getTime() + 1000), note)
  ).rejects.toThrow()
  expect(await count(guildId, 'events')).toBe(before)
})
