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
const NO_AUTH = { reauthenticated: false }
const AUTH = { reauthenticated: true }

async function approve(store: SealStore, guild: string, id: string) {
  const seal = await store.get(guild, id)
  return store.decide(guild, id, { verdict: 'approved', expectedHash: seal?.actionHash ?? '' })
}

async function reserveToken(store: SealStore, guild: string, id: string): Promise<string> {
  const held = await store.reserve(guild, id, TEXT)
  if (!held.ok) {
    throw new Error(`reserve refused: ${held.reason}`)
  }
  return held.token
}

async function seed(store: SealStore, guild: string, text = TEXT) {
  const seal = await store.request(guild, {
    questId: crypto.randomUUID(),
    requestedBy: 'herald-1',
    kind: 'post',
    text,
    evidence: 'verdict: pass',
  })
  return { seal, hash: await hashProposal(text) }
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
      })
      expect(again.id).toBe(seal.id)
    })

    test('a revision after a denial is a new round and a new Seal row, found as the Quest’s latest', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(seal.round).toBe(1)
      await store.decide(g, seal.id, { verdict: 'denied', expectedHash: hash })
      const retry = await store.request(g, {
        questId: seal.questId,
        requestedBy: seal.requestedBy,
        kind: seal.kind,
        text: seal.text,
        evidence: seal.evidence,
        round: 2,
      })
      expect(retry.id).not.toBe(seal.id)
      expect(retry).toMatchObject({ round: 2, status: 'requested' })
      const same = await store.request(g, {
        questId: seal.questId,
        requestedBy: seal.requestedBy,
        kind: seal.kind,
        text: seal.text,
        evidence: seal.evidence,
        round: 2,
      })
      expect(same.id).toBe(retry.id)
      expect((await store.forQuest(g, seal.questId))?.id).toBe(retry.id)
      expect(await store.forQuest(g, crypto.randomUUID())).toBeNull()
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

    test('a decision records who decided, readable back', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(seal.decidedBy).toBeNull()
      const who = crypto.randomUUID()
      const done = await store.decide(g, seal.id, {
        verdict: 'denied',
        expectedHash: hash,
        decidedBy: who,
      })
      expect(done).toMatchObject({ ok: true, seal: { decidedBy: who } })
      expect((await store.get(g, seal.id))?.decidedBy).toBe(who)
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

    test('the store binds the hash of the text itself: a Seal reports sha256(text)', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal, hash } = await seed(store, g)
      expect(seal.actionHash).toBe(hash)
      expect(hash).toBe('5a5c58ae0fd5dc61f8f155e8ceb59bb792841a8c4c334fb0e6bbc04e395d8c88')
    })

    test('reserve then consume works once; a second consume is refused', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      expect(await store.reserve(g, seal.id, TEXT)).toEqual({ ok: false, reason: 'not_approved' })
      await approve(store, g, seal.id)
      const held = await store.reserve(g, seal.id, TEXT)
      expect(held).toMatchObject({ ok: true, seal: { status: 'reserved', stale: false } })
      const token = held.ok ? held.token : ''
      expect(await store.consume(g, seal.id, { text: TEXT, token })).toMatchObject({
        ok: true,
        seal: { status: 'consumed' },
      })
      expect(await store.consume(g, seal.id, { text: TEXT, token })).toEqual({
        ok: false,
        reason: 'not_reserved',
      })
      expect(await store.reserve(g, seal.id, TEXT)).toEqual({ ok: false, reason: 'not_approved' })
    })

    test('different text cannot be reserved, consumed or posted', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const other = 'a different payload'
      expect(await store.reserve(g, seal.id, other)).toEqual({ ok: false, reason: 'hash_mismatch' })
      expect(await store.markPosted(g, seal.id, other, NO_AUTH)).toEqual({
        ok: false,
        reason: 'hash_mismatch',
      })
      const token = await reserveToken(store, g, seal.id)
      expect(await store.consume(g, seal.id, { text: other, token })).toEqual({
        ok: false,
        reason: 'hash_mismatch',
      })
      expect((await store.get(g, seal.id))?.status).toBe('reserved')
    })

    test('a wrong token cannot consume or release', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const token = await reserveToken(store, g, seal.id)
      expect(await store.consume(g, seal.id, { text: TEXT, token: 'nope' })).toEqual({
        ok: false,
        reason: 'bad_token',
      })
      expect(await store.release(g, seal.id, { token: 'nope' })).toEqual({
        ok: false,
        reason: 'bad_token',
      })
      expect((await store.get(g, seal.id))?.status).toBe('reserved')
      expect(await store.release(g, seal.id, { token })).toMatchObject({
        ok: true,
        seal: { status: 'released' },
      })
    })

    test('two same-tick reservations give exactly one token; same-tick consumes exactly one success', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const reserved = await Promise.all([
        store.reserve(g, seal.id, TEXT),
        store.reserve(g, seal.id, TEXT),
      ])
      expect(reserved.filter((r) => r.ok)).toHaveLength(1)
      const won = reserved.find((r) => r.ok)
      const token = won?.ok ? won.token : ''
      const consumed = await Promise.all([
        store.consume(g, seal.id, { text: TEXT, token }),
        store.consume(g, seal.id, { text: TEXT, token }),
      ])
      expect(consumed.filter((r) => r.ok)).toHaveLength(1)
    })

    test('a lapsed reservation is stale: it cannot be reserved again, but its holder can still consume once', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const tokenA = await reserveToken(store, g, seal.id)
      clock.advance(SEAL_RESERVATION_MS)
      expect(await store.get(g, seal.id)).toMatchObject({ status: 'reserved', stale: true })
      expect(await store.reserve(g, seal.id, TEXT)).toEqual({ ok: false, reason: 'not_approved' })
      expect(await store.consume(g, seal.id, { text: TEXT, token: tokenA })).toMatchObject({
        ok: true,
        seal: { status: 'consumed' },
      })
      expect(await store.consume(g, seal.id, { text: TEXT, token: tokenA })).toEqual({
        ok: false,
        reason: 'not_reserved',
      })
    })

    test('a stale holder cannot act on a later reservation', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const tokenA = await reserveToken(store, g, seal.id)
      clock.advance(SEAL_RESERVATION_MS)
      expect(await store.releaseStale(g, seal.id)).toMatchObject({
        ok: true,
        seal: { status: 'released' },
      })
      const tokenB = await reserveToken(store, g, seal.id)
      expect(await store.release(g, seal.id, { token: tokenA })).toEqual({
        ok: false,
        reason: 'bad_token',
      })
      expect(await store.consume(g, seal.id, { text: TEXT, token: tokenA })).toEqual({
        ok: false,
        reason: 'bad_token',
      })
      expect(await store.consume(g, seal.id, { text: TEXT, token: tokenB })).toMatchObject({
        ok: true,
      })
    })

    test('only a stale reservation can be resolved by the Guild Master', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      await reserveToken(store, g, seal.id)
      expect(await store.releaseStale(g, seal.id)).toEqual({ ok: false, reason: 'not_stale' })
      expect(await store.markPosted(g, seal.id, TEXT, AUTH)).toEqual({
        ok: false,
        reason: 'not_approved',
      })
      clock.advance(SEAL_RESERVATION_MS)
      expect(await store.markPosted(g, seal.id, TEXT, NO_AUTH)).toEqual({
        ok: false,
        reason: 'not_authorised',
      })
      expect((await store.get(g, seal.id))?.status).toBe('reserved')
      expect(await store.markPosted(g, seal.id, TEXT, AUTH)).toMatchObject({
        ok: true,
        seal: { status: 'consumed' },
      })
    })

    test('a released Seal can be reserved again', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      await approve(store, g, seal.id)
      const token = await reserveToken(store, g, seal.id)
      await store.release(g, seal.id, { token })
      expect(await store.reserve(g, seal.id, TEXT)).toMatchObject({ ok: true })
    })

    test('marking posted consumes an approved Seal once', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const { seal } = await seed(store, g)
      expect(await store.markPosted(g, seal.id, TEXT, NO_AUTH)).toEqual({
        ok: false,
        reason: 'not_approved',
      })
      await approve(store, g, seal.id)
      const posts = await Promise.all([
        store.markPosted(g, seal.id, TEXT, NO_AUTH),
        store.markPosted(g, seal.id, TEXT, NO_AUTH),
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
