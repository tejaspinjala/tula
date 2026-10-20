import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { hashProposal, SEAL_RESERVATION_MS, SEAL_TTL_MS, type SealStore } from './seal-store'

/** A store under test, the clock it reads, and a way to get real guilds. */
export interface SealStoreFixture {
  store: SealStore
  clock: MemoryClock
  newGuild: () => Promise<string>
}

const TEXT = 'Ship the launch post: hello world'

async function seed(store: SealStore, guild: string, text = TEXT) {
  const actionHash = await hashProposal(text)
  const seal = await store.request(guild, {
    questId: crypto.randomUUID(),
    requestedBy: 'herald-1',
    kind: 'post',
    text,
    evidence: 'verdict: pass',
    actionHash,
  })
  return { seal, hash: actionHash }
}

/** The SealStore contract, run against every adapter. `make` returns a fresh store. */
export function sealStoreContract(name: string, make: () => Promise<SealStoreFixture>) {
  describe(`SealStore contract: ${name}`, () => {
    test('a requested Seal carries the exact text, evidence and hash, and expires in 72 hours', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(seal).toMatchObject({ status: 'requested', text: TEXT, actionHash: hash })
      expect(Date.parse(seal.expiresAt) - clock.now().getTime()).toBe(SEAL_TTL_MS)
      expect(await store.get(g, seal.id)).toEqual(seal)
    })

    test('requesting the same quest and hash again returns the same Seal', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      const again = await store.request(g, {
        questId: seal.questId,
        requestedBy: seal.requestedBy,
        kind: seal.kind,
        text: seal.text,
        evidence: seal.evidence,
        actionHash: seal.actionHash,
      })
      expect(again.id).toBe(seal.id)
    })

    test('approving binds to the hash: a different hash decides nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      const other = await hashProposal('a different payload')
      expect(await store.decide(g, seal.id, { verdict: 'approved', expectedHash: other })).toEqual({
        ok: false,
        reason: 'hash_mismatch',
      })
      expect((await store.get(g, seal.id))?.status).toBe('requested')
      const done = await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      expect(done).toMatchObject({ ok: true, seal: { status: 'approved' } })
    })

    test('a decision is final: it cannot be decided again or flipped', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      const denied = await store.decide(g, seal.id, {
        verdict: 'denied',
        expectedHash: hash,
        note: 'tone is off',
      })
      expect(denied).toMatchObject({
        ok: true,
        seal: { status: 'denied', decisionNote: 'tone is off' },
      })
      expect(await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })).toEqual({
        ok: false,
        reason: 'not_requested',
      })
      expect((await store.get(g, seal.id))?.status).toBe('denied')
    })

    test('two same-tick decisions give exactly one success', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      const results = await Promise.all([
        store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash }),
        store.decide(g, seal.id, { verdict: 'denied', expectedHash: hash }),
      ])
      expect(results.filter((r) => r.ok)).toHaveLength(1)
    })

    test('a Seal past its expiry reads as expired and cannot be decided', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      clock.advance(SEAL_TTL_MS)
      expect((await store.get(g, seal.id))?.status).toBe('expired')
      expect(await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })).toEqual({
        ok: false,
        reason: 'expired',
      })
      expect((await store.get(g, seal.id))?.status).toBe('expired')
    })

    test('expireDue persists expiry once per lapsed Seal', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      await seed(store, g)
      await seed(store, g, 'second')
      clock.advance(SEAL_TTL_MS)
      expect(await store.expireDue(g)).toBe(2)
      expect(await store.expireDue(g)).toBe(0)
    })

    test('reserve then consume works once; a second consume is refused', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(await store.reserve(g, seal.id, hash)).toEqual({ ok: false, reason: 'not_approved' })
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      expect(await store.reserve(g, seal.id, hash)).toMatchObject({
        ok: true,
        seal: { status: 'reserved' },
      })
      expect(await store.consume(g, seal.id, hash)).toMatchObject({
        ok: true,
        seal: { status: 'consumed' },
      })
      expect(await store.consume(g, seal.id, hash)).toEqual({ ok: false, reason: 'not_reserved' })
      expect(await store.reserve(g, seal.id, hash)).toEqual({ ok: false, reason: 'not_approved' })
    })

    test('an approved Seal cannot be reserved or consumed for a different hash', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      const other = await hashProposal('other')
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      expect(await store.reserve(g, seal.id, other)).toEqual({
        ok: false,
        reason: 'hash_mismatch',
      })
      await store.reserve(g, seal.id, hash)
      expect(await store.consume(g, seal.id, other)).toEqual({
        ok: false,
        reason: 'hash_mismatch',
      })
      expect((await store.get(g, seal.id))?.status).toBe('reserved')
    })

    test('two same-tick reservations or consumptions give exactly one success', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      const reserved = await Promise.all([
        store.reserve(g, seal.id, hash),
        store.reserve(g, seal.id, hash),
      ])
      expect(reserved.filter((r) => r.ok)).toHaveLength(1)
      const consumed = await Promise.all([
        store.consume(g, seal.id, hash),
        store.consume(g, seal.id, hash),
      ])
      expect(consumed.filter((r) => r.ok)).toHaveLength(1)
    })

    test('a lapsed reservation reads as approved and can be reserved again', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      await store.reserve(g, seal.id, hash)
      clock.advance(SEAL_RESERVATION_MS)
      expect((await store.get(g, seal.id))?.status).toBe('approved')
      expect(await store.consume(g, seal.id, hash)).toEqual({ ok: false, reason: 'not_reserved' })
      expect(await store.reserve(g, seal.id, hash)).toMatchObject({ ok: true })
    })

    test('a released Seal can be reserved again', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      await store.reserve(g, seal.id, hash)
      expect(await store.release(g, seal.id, hash)).toMatchObject({
        ok: true,
        seal: { status: 'released' },
      })
      expect(await store.reserve(g, seal.id, hash)).toMatchObject({ ok: true })
    })

    test('marking posted consumes an approved Seal once', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(await store.markPosted(g, seal.id, hash)).toEqual({
        ok: false,
        reason: 'not_approved',
      })
      await store.decide(g, seal.id, { verdict: 'approved', expectedHash: hash })
      const posts = await Promise.all([
        store.markPosted(g, seal.id, hash),
        store.markPosted(g, seal.id, hash),
      ])
      expect(posts.filter((r) => r.ok)).toHaveLength(1)
      expect((await store.get(g, seal.id))?.status).toBe('consumed')
    })

    test('lists are paginated, optionally by status, and cover this guild only', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const a = await seed(store, g, 'one')
      await seed(store, g, 'two')
      await seed(store, g, 'three')
      await seed(store, other, 'elsewhere')
      await store.decide(g, a.seal.id, { verdict: 'approved', expectedHash: a.hash })
      const first = await store.list(g, { limit: 2 })
      expect(first.seals).toHaveLength(2)
      expect(first.next).not.toBeNull()
      const second = await store.list(g, { limit: 2, ...(first.next ? { after: first.next } : {}) })
      expect(second.seals).toHaveLength(1)
      expect(second.next).toBeNull()
      const pending = await store.list(g, { limit: 10, status: 'requested' })
      expect(pending.seals).toHaveLength(2)
    })

    test("another guild cannot read or decide a guild's Seal", async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(await store.get(other, seal.id)).toBeNull()
      expect(
        await store.decide(other, seal.id, { verdict: 'approved', expectedHash: hash })
      ).toEqual({ ok: false, reason: 'not_found' })
      expect((await store.get(g, seal.id))?.status).toBe('requested')
    })
  })
}
