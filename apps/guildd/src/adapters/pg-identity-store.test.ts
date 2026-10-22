import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { MAX_OUTSTANDING_CHALLENGES, MAX_OUTSTANDING_DESKTOP_CODES } from '../ports/identity'
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
  const master = await store.guildMaster(guildId)
  const session = {
    id: crypto.randomUUID(),
    memberId: master.memberId,
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

function desktopCode(hash: string, ttlMs = 60_000, sessionMs = 3_600_000) {
  return {
    codeHash: hash,
    stateHash: `state-${hash}`,
    expiresAt: new Date(T0.getTime() + ttlMs),
    sessionExpiresAt: new Date(T0.getTime() + sessionMs),
  }
}

test("one guild cannot spend another guild's desktop code, even with its hash", async () => {
  const a = await foundTestGuild(db, { name: 'CodeA', goal: 'g' })
  const b = await foundTestGuild(db, { name: 'CodeB', goal: 'g' })
  await store.issueDesktopCode(a, desktopCode('hash-a'), T0, note)
  expect(await store.spendDesktopCode(b, 'hash-a', 'state-hash-a', T0, note)).toBeNull()
  expect(await count(a, 'identity_desktop_codes')).toBe(1)
  expect(await store.spendDesktopCode(a, 'hash-a', 'state-hash-a', T0, note)).toEqual(
    new Date(T0.getTime() + 3_600_000)
  )
  expect(await count(a, 'identity_desktop_codes')).toBe(0)
})

test('a desktop code needs its own state hash to be spent', async () => {
  const a = await foundTestGuild(db, { name: 'CodeState', goal: 'g' })
  await store.issueDesktopCode(a, desktopCode('hash-s'), T0, note)
  expect(await store.spendDesktopCode(a, 'hash-s', 'other', T0, note)).toBeNull()
  expect(await count(a, 'identity_desktop_codes')).toBe(1)
})

test("issuing a desktop code deletes the guild's expired ones and keeps the live ones", async () => {
  const a = await foundTestGuild(db, { name: 'CodeSweep', goal: 'g' })
  await store.issueDesktopCode(a, desktopCode('old', 1000), T0, note)
  await store.issueDesktopCode(a, desktopCode('live'), T0, note)
  expect(await count(a, 'identity_desktop_codes')).toBe(2)
  await store.issueDesktopCode(a, desktopCode('new'), new Date(T0.getTime() + 5000), note)
  expect(await count(a, 'identity_desktop_codes')).toBe(2)
  expect(await store.spendDesktopCode(a, 'live', 'state-live', T0, note)).not.toBeNull()
})

test('outstanding desktop codes per guild are capped, evicting the oldest', async () => {
  const a = await foundTestGuild(db, { name: 'CodeCap', goal: 'g' })
  for (let i = 0; i <= MAX_OUTSTANDING_DESKTOP_CODES; i++) {
    await store.issueDesktopCode(a, desktopCode(`c${i}`, 10_000 + i), T0, note)
  }
  expect(await count(a, 'identity_desktop_codes')).toBe(MAX_OUTSTANDING_DESKTOP_CODES)
  expect(await store.spendDesktopCode(a, 'c0', 'state-c0', T0, note)).toBeNull()
  expect(await store.spendDesktopCode(a, 'c1', 'state-c1', T0, note)).not.toBeNull()
})

test('a failure after the first passkey is written rolls back the guild, its events, chain and passkey', async () => {
  const name = `Founding ${crypto.randomUUID()}`
  const credential = { ...cred, id: `rollback-${crypto.randomUUID()}` }
  await expect(
    db.foundGuildChained({ name, goal: 'g' }, new MemoryKeyProvider(), async (tx, id) => {
      await store.saveCredential(id, credential, note, tx)
      throw new Error('seed failed after the passkey')
    })
  ).rejects.toThrow('seed failed')
  const [guilds] = await owner`select count(*)::int as n from guilds where name = ${name}`
  expect(Number(guilds?.n)).toBe(0)
  const [creds] =
    await owner`select count(*)::int as n from identity_credentials where credential_id = ${credential.id}`
  expect(Number(creds?.n)).toBe(0)
  const [orphans] = await owner`select
    (select count(*) from events where guild_id not in (select guild_id from guilds))::int as events,
    (select count(*) from audit_chain where guild_id not in (select guild_id from guilds))::int as chain`
  expect([orphans?.events, orphans?.chain]).toEqual([0, 0])
})
