import { describe, expect, test } from 'bun:test'
import { DEFAULT_TREASURY } from '../guild-config'
import type { TreasuryStore } from './treasury-store'

/** A store under test; a database-backed store needs real guilds. */
export interface TreasuryStoreFixture {
  store: TreasuryStore
  newGuild: () => Promise<string>
  /** Moves the store's clock forward. */
  advanceMs: (ms: number) => void
  /** Rewrites one stored ledger entry's amount behind the store's back, as a hostile DBA would. */
  tamper: (guildId: string, seq: number, amountCents: number) => Promise<void>
}

const LIMITS = DEFAULT_TREASURY
const ACTOR = 'member-1'

/** The TreasuryStore contract, run against every adapter. `make` returns a fresh store. */
export function treasuryStoreContract(name: string, make: () => Promise<TreasuryStoreFixture>) {
  describe(`TreasuryStore contract: ${name}`, () => {
    test('a new Treasury holds $100 of paper, 30% in reserve', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const snap = await store.snapshot(g, LIMITS)
      expect(snap).toMatchObject({
        mode: 'paper',
        balances: { operating: 7000, reserve: 3000, profit: 0 },
        spentTodayCents: 0,
      })
    })

    test('revenue reinvests 40% into the operating envelope and keeps the rest as profit', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const result = await store.recordRevenue(
        g,
        { actorMember: ACTOR, key: 'inv-1', amountCents: 1001, evidence: 'invoice #1' },
        LIMITS
      )
      expect(result.ok).toBe(true)
      const snap = await store.snapshot(g, LIMITS)
      expect(snap.balances).toEqual({ operating: 7400, reserve: 3000, profit: 601 })
    })

    test('revenue without evidence is rejected and moves nothing', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const evidence of ['', '   ']) {
        const result = await store.recordRevenue(
          g,
          { actorMember: ACTOR, key: `k-${evidence.length}`, amountCents: 500, evidence },
          LIMITS
        )
        expect(result).toEqual({ ok: false, reason: 'evidence_required' })
      }
      expect((await store.snapshot(g, LIMITS)).balances).toEqual({
        operating: 7000,
        reserve: 3000,
        profit: 0,
      })
    })

    test('a retried revenue key records once', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const input = { actorMember: ACTOR, key: 'inv-1', amountCents: 1000, evidence: 'invoice #1' }
      const first = await store.recordRevenue(g, input, LIMITS)
      const again = await store.recordRevenue(g, input, LIMITS)
      expect(first).toMatchObject({ ok: true, created: true })
      expect(again).toMatchObject({ ok: true, created: false })
      expect((await store.snapshot(g, LIMITS)).balances.profit).toBe(600)
    })

    test('amounts are positive integer cents', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const amountCents of [0, -5, 1.5]) {
        expect(
          await store.recordRevenue(
            g,
            { actorMember: ACTOR, key: 'k', amountCents, evidence: 'e' },
            LIMITS
          )
        ).toEqual({ ok: false, reason: 'invalid_amount' })
      }
    })

    describe('spend requests', () => {
      const spend = (key: string, amountCents: number) => ({
        key,
        amountCents,
        purpose: 'domain renewal',
        requestedBy: 'treasurer',
      })

      test('a spend up to $5 within the daily cap is approved by the Treasurer and reserved at once', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const result = await store.requestSpend(g, spend('s1', 500), LIMITS)
        expect(result).toMatchObject({
          ok: true,
          created: true,
          spend: { status: 'reserved', approvedBy: 'treasurer', amountCents: 500 },
        })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap.balances.operating).toBe(6500)
        expect(snap.spentTodayCents).toBe(500)
      })

      test('a spend over $5 waits for the Guild Master and holds nothing', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const result = await store.requestSpend(g, spend('s1', 501), LIMITS)
        expect(result).toMatchObject({
          ok: true,
          spend: { status: 'pending_approval', escalation: 'over_treasurer_limit' },
        })
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(7000)
      })

      test('a spend past the $10 daily cap waits for the Guild Master until the next UTC day', async () => {
        const { store, newGuild, advanceMs } = await make()
        const g = await newGuild()
        await store.requestSpend(g, spend('a', 500), LIMITS)
        await store.requestSpend(g, spend('b', 500), LIMITS)
        const third = await store.requestSpend(g, spend('c', 1), LIMITS)
        expect(third).toMatchObject({
          ok: true,
          spend: { status: 'pending_approval', escalation: 'daily_cap' },
        })
        advanceMs(24 * 60 * 60 * 1000)
        const next = await store.requestSpend(g, spend('d', 1), LIMITS)
        expect(next).toMatchObject({ ok: true, spend: { status: 'reserved' } })
      })

      test('a spend the operating envelope cannot cover is refused', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const loose = { ...LIMITS, treasurerLimitCents: 100_000, dailyCapCents: 100_000 }
        expect(await store.requestSpend(g, spend('big', 7001), loose)).toEqual({
          ok: false,
          reason: 'insufficient_funds',
        })
      })

      test('a retried request key is the same request and reserves once', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const first = await store.requestSpend(g, spend('s1', 300), LIMITS)
        const again = await store.requestSpend(g, spend('s1', 300), LIMITS)
        expect(again).toMatchObject({ ok: true, created: false })
        expect(first.ok && again.ok && first.spend.id === again.spend.id).toBe(true)
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(6700)
      })

      test('amounts are positive integer cents', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        for (const amountCents of [0, -1, 2.5]) {
          expect(await store.requestSpend(g, spend('x', amountCents), LIMITS)).toEqual({
            ok: false,
            reason: 'invalid_amount',
          })
        }
      })
    })

    describe('Guild Master decisions and settlement', () => {
      const spend = (key: string, amountCents: number) => ({
        key,
        amountCents,
        purpose: 'ads',
        requestedBy: 'treasurer',
      })
      const request = async (store: TreasuryStore, g: string, key: string, cents: number) => {
        const r = await store.requestSpend(g, spend(key, cents), LIMITS)
        if (!r.ok) {
          throw new Error(`refused: ${r.reason}`)
        }
        return r.spend
      }

      test('the Guild Master approves a waiting spend, even past the daily cap, and it reserves', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        await request(store, g, 'a', 500)
        await request(store, g, 'b', 500)
        const waiting = await request(store, g, 'c', 800)
        expect(waiting.status).toBe('pending_approval')
        const approved = await store.approveSpend(g, waiting.id, ACTOR)
        expect(approved).toMatchObject({
          ok: true,
          spend: { status: 'reserved', approvedBy: 'guild_master' },
        })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap.balances.operating).toBe(5200)
        expect(snap.spentTodayCents).toBe(1800)
      })

      test('approval re-checks funds: a spend that is no longer covered stays waiting', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const waiting = await request(store, g, 'w', 600)
        const loose = { ...LIMITS, treasurerLimitCents: 100_000, dailyCapCents: 100_000 }
        await store.requestSpend(g, spend('drain', 6800), loose)
        expect(await store.approveSpend(g, waiting.id, ACTOR)).toEqual({
          ok: false,
          reason: 'insufficient_funds',
        })
        expect((await store.getSpend(g, waiting.id))?.status).toBe('pending_approval')
      })

      test('only a waiting spend can be approved or denied', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 100)
        const waiting = await request(store, g, 'w', 900)
        expect(await store.approveSpend(g, reserved.id, ACTOR)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.denySpend(g, waiting.id, ACTOR)).toMatchObject({
          ok: true,
          spend: { status: 'denied' },
        })
        expect(await store.approveSpend(g, waiting.id, ACTOR)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.approveSpend(g, crypto.randomUUID(), ACTOR)).toEqual({
          ok: false,
          reason: 'not_found',
        })
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(6900)
      })

      test('settling returns what was reserved but not spent, and counts only the actual spend', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 500)
        const settled = await store.settleSpend(g, reserved.id, 320, ACTOR)
        expect(settled).toMatchObject({ ok: true, spend: { status: 'settled', settledCents: 320 } })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap.balances.operating).toBe(6680)
        expect(snap.spentTodayCents).toBe(320)
        expect(await store.settleSpend(g, reserved.id, 320, ACTOR)).toMatchObject({ ok: true })
        expect(await store.settleSpend(g, reserved.id, 100, ACTOR)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(6680)
      })

      test('settling above the reservation, or a spend that holds nothing, is refused', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 500)
        const waiting = await request(store, g, 'w', 900)
        expect(await store.settleSpend(g, reserved.id, 501, ACTOR)).toEqual({
          ok: false,
          reason: 'exceeds_reserved',
        })
        expect(await store.settleSpend(g, waiting.id, 100, ACTOR)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.settleSpend(g, reserved.id, -1, ACTOR)).toEqual({
          ok: false,
          reason: 'invalid_amount',
        })
      })

      test('releasing a reservation frees all of it and is idempotent', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 500)
        expect(await store.releaseSpend(g, reserved.id, ACTOR)).toMatchObject({
          ok: true,
          spend: { status: 'released' },
        })
        expect(await store.releaseSpend(g, reserved.id, ACTOR)).toMatchObject({ ok: true })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap).toMatchObject({ spentTodayCents: 0 })
        expect(snap.balances.operating).toBe(7000)
        const other = await request(store, g, 's', 100)
        await store.settleSpend(g, other.id, 100, ACTOR)
        expect(await store.releaseSpend(g, other.id, ACTOR)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
      })
    })

    describe('reserve', () => {
      test('the reserve moves to operating only by an explicit release, once per key', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const input = { actorMember: ACTOR, key: 'r1', amountCents: 1000 }
        expect(await store.releaseReserve(g, input, LIMITS)).toMatchObject({
          ok: true,
          created: true,
        })
        expect(await store.releaseReserve(g, input, LIMITS)).toMatchObject({
          ok: true,
          created: false,
        })
        expect((await store.snapshot(g, LIMITS)).balances).toEqual({
          operating: 8000,
          reserve: 2000,
          profit: 0,
        })
      })

      test('a release above the reserve, or of a non-positive amount, is refused', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        expect(
          await store.releaseReserve(g, { actorMember: ACTOR, key: 'a', amountCents: 3001 }, LIMITS)
        ).toEqual({
          ok: false,
          reason: 'insufficient_funds',
        })
        expect(
          await store.releaseReserve(g, { actorMember: ACTOR, key: 'b', amountCents: 0 }, LIMITS)
        ).toEqual({
          ok: false,
          reason: 'invalid_amount',
        })
      })
    })

    describe('daily cap across midnight', () => {
      test('a refund after UTC midnight only offsets the day it was reserved on', async () => {
        const { store, newGuild, advanceMs } = await make()
        const g = await newGuild()
        const HOUR = 60 * 60 * 1000
        advanceMs(11 * HOUR) // 23:00 UTC
        const ask = (key: string) =>
          store.requestSpend(g, { key, amountCents: 500, purpose: 'p', requestedBy: 't' }, LIMITS)
        const first = await ask('a')
        const second = await ask('b')
        advanceMs(2 * HOUR) // 01:00 UTC the next day
        for (const r of [first, second]) {
          if (!r.ok) {
            throw new Error('refused')
          }
          await store.releaseSpend(g, r.spend.id, ACTOR)
        }
        expect((await store.snapshot(g, LIMITS)).spentTodayCents).toBe(0)
        const results = []
        for (const k of ['c', 'd', 'e', 'f']) {
          results.push(await ask(k))
        }
        const statuses = results.map((r) => (r.ok ? r.spend.status : r.reason))
        expect(statuses.filter((x) => x === 'reserved')).toHaveLength(2)
        expect(results.filter((r) => r.ok && r.spend.escalation === 'daily_cap')).toHaveLength(2)
      })
    })

    describe('principals', () => {
      test('every entry and approval records the member who acted; the seed has none', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        await store.recordRevenue(
          g,
          { actorMember: 'rev-1', key: 'r', amountCents: 1000, evidence: 'inv' },
          LIMITS
        )
        await store.releaseReserve(g, { actorMember: 'res-1', key: 'rr', amountCents: 100 }, LIMITS)
        const waiting = await store.requestSpend(
          g,
          { key: 'w', amountCents: 600, purpose: 'p', requestedBy: 'req-1' },
          LIMITS
        )
        if (!waiting.ok) {
          throw new Error('refused')
        }
        expect(waiting.spend).toMatchObject({ requestedBy: 'req-1', approvedByMember: null })
        const approved = await store.approveSpend(g, waiting.spend.id, 'gm-7')
        expect(approved).toMatchObject({ ok: true, spend: { approvedByMember: 'gm-7' } })
        await store.settleSpend(g, waiting.spend.id, 500, 'settler-1')
        const small = await store.requestSpend(
          g,
          { key: 's', amountCents: 100, purpose: 'p', requestedBy: 'req-1' },
          LIMITS
        )
        if (!small.ok) {
          throw new Error('refused')
        }
        await store.releaseSpend(g, small.spend.id, 'releaser-1')
        const entries = (await store.listEntries(g, { limit: 100 })).items
        const actors = entries.map((e) => `${e.kind}:${e.actorMember}`)
        expect(actors).toEqual([
          'seed:null',
          'seed:null',
          'revenue:rev-1',
          'revenue:rev-1',
          'reserve_release:res-1',
          'reserve_release:res-1',
          'spend_reserve:gm-7',
          'spend_settle:settler-1',
          'spend_reserve:req-1',
          'spend_release:releaser-1',
        ])
        expect(await store.verifyLedger(g)).toMatchObject({ intact: true })
      })
    })

    describe('atomicity', () => {
      const loose = { ...LIMITS, treasurerLimitCents: 100_000, dailyCapCents: 100_000 }
      const ask = (g: string, store: TreasuryStore, key: string, amountCents: number, l = loose) =>
        store.requestSpend(g, { key, amountCents, purpose: 'p', requestedBy: 't' }, l)

      test('same-tick spends can never overspend the operating envelope', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const results = await Promise.all(
          Array.from({ length: 20 }, (_, i) => ask(g, store, `k${i}`, 400))
        )
        expect(results.filter((r) => r.ok)).toHaveLength(17)
        expect(results.filter((r) => !r.ok && r.reason === 'insufficient_funds')).toHaveLength(3)
        expect((await store.snapshot(g, loose)).balances.operating).toBe(200)
      })

      test('same-tick spends can never pass the daily cap between them', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const results = await Promise.all(
          Array.from({ length: 5 }, (_, i) => ask(g, store, `k${i}`, 400, LIMITS))
        )
        const statuses = results.map((r) => (r.ok ? r.spend.status : r.reason))
        expect(statuses.filter((x) => x === 'reserved')).toHaveLength(2)
        expect(statuses.filter((x) => x === 'pending_approval')).toHaveLength(3)
        expect((await store.snapshot(g, LIMITS)).spentTodayCents).toBe(800)
      })

      test('the same key sent same-tick creates one request and one reservation', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const results = await Promise.all(
          Array.from({ length: 6 }, () => ask(g, store, 'same', 300, LIMITS))
        )
        expect(results.filter((r) => r.ok && r.created)).toHaveLength(1)
        expect(new Set(results.map((r) => (r.ok ? r.spend.id : ''))).size).toBe(1)
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(6700)
      })

      test('a settle and a release racing on one reservation: exactly one wins', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const r = await ask(g, store, 'k', 400, LIMITS)
        if (!r.ok) {
          throw new Error('refused')
        }
        const [a, b] = await Promise.all([
          store.settleSpend(g, r.spend.id, 100, ACTOR),
          store.releaseSpend(g, r.spend.id, ACTOR),
        ])
        expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1)
        const operating = (await store.snapshot(g, LIMITS)).balances.operating
        expect([6900, 7000]).toContain(operating)
      })
    })

    describe('ledger', () => {
      test('the hash chain verifies, and altering any entry breaks it at that entry', async () => {
        const { store, newGuild, tamper } = await make()
        const g = await newGuild()
        await store.recordRevenue(
          g,
          { actorMember: ACTOR, key: 'r', amountCents: 1000, evidence: 'inv' },
          LIMITS
        )
        await store.requestSpend(
          g,
          { key: 's', amountCents: 100, purpose: 'p', requestedBy: 't' },
          LIMITS
        )
        const intact = await store.verifyLedger(g)
        expect(intact).toEqual({ intact: true, entries: 5 })
        await tamper(g, 3, 999_999)
        expect(await store.verifyLedger(g)).toMatchObject({ intact: false, firstBadSeq: 3 })
      })

      test('entries are listed oldest first in pages, each carrying its chain hash', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        await store.recordRevenue(
          g,
          { actorMember: ACTOR, key: 'r', amountCents: 1000, evidence: 'inv' },
          LIMITS
        )
        const seen: number[] = []
        let after: number | undefined
        for (let pages = 0; pages < 10; pages++) {
          const page = await store.listEntries(g, { limit: 2, ...(after ? { after } : {}) })
          expect(page.items.length).toBeLessThanOrEqual(2)
          seen.push(...page.items.map((e) => e.seq))
          if (page.next === null) {
            break
          }
          after = page.next
        }
        expect(seen).toEqual([1, 2, 3, 4])
        const all = await store.listEntries(g, { limit: 100 })
        expect(all.items.every((e) => e.mode === 'paper' && /^[0-9a-f]{64}$/.test(e.hash))).toBe(
          true
        )
        expect(all.items[1]?.prevHash).toBe(all.items[0]?.hash)
      })

      test('spend requests are listed oldest first in pages', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        for (const k of ['a', 'b', 'c']) {
          await store.requestSpend(
            g,
            { key: k, amountCents: 100, purpose: 'p', requestedBy: 't' },
            LIMITS
          )
        }
        const first = await store.listSpends(g, { limit: 2 })
        expect(first.items.map((s) => s.key)).toEqual(['a', 'b'])
        expect(first.next).not.toBeNull()
        const second = await store.listSpends(g, { limit: 2, after: first.next ?? 0 })
        expect(second.items.map((s) => s.key)).toEqual(['c'])
        expect(second.next).toBeNull()
      })

      test("one guild never sees or moves another guild's Treasury", async () => {
        const { store, newGuild } = await make()
        const a = await newGuild()
        const b = await newGuild()
        const r = await store.requestSpend(
          a,
          { key: 's', amountCents: 100, purpose: 'p', requestedBy: 't' },
          LIMITS
        )
        if (!r.ok) {
          throw new Error('refused')
        }
        await store.snapshot(b, LIMITS)
        expect(await store.getSpend(b, r.spend.id)).toBeNull()
        expect(await store.settleSpend(b, r.spend.id, 1, ACTOR)).toEqual({
          ok: false,
          reason: 'not_found',
        })
        expect((await store.listSpends(b, { limit: 10 })).items).toEqual([])
        expect((await store.snapshot(b, LIMITS)).balances.operating).toBe(7000)
        expect((await store.listEntries(b, { limit: 100 })).items.map((e) => e.spendId)).toEqual([
          null,
          null,
        ])
      })
    })
  })
}
