import { describe, expect, test } from 'bun:test'
import { DEFAULT_TREASURY } from '../guild-config'
import type { TreasuryStore } from './treasury-store'

/** A store under test; a database-backed store needs real guilds. */
export interface TreasuryStoreFixture {
  store: TreasuryStore
  newGuild: () => Promise<string>
  /** Moves the store's clock forward. */
  advanceMs: (ms: number) => void
}

const LIMITS = DEFAULT_TREASURY

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
        { key: 'inv-1', amountCents: 1001, evidence: 'invoice #1' },
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
          { key: `k-${evidence.length}`, amountCents: 500, evidence },
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
      const input = { key: 'inv-1', amountCents: 1000, evidence: 'invoice #1' }
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
          await store.recordRevenue(g, { key: 'k', amountCents, evidence: 'e' }, LIMITS)
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
        const approved = await store.approveSpend(g, waiting.id)
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
        expect(await store.approveSpend(g, waiting.id)).toEqual({
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
        expect(await store.approveSpend(g, reserved.id)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.denySpend(g, waiting.id)).toMatchObject({
          ok: true,
          spend: { status: 'denied' },
        })
        expect(await store.approveSpend(g, waiting.id)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.approveSpend(g, crypto.randomUUID())).toEqual({
          ok: false,
          reason: 'not_found',
        })
        expect((await store.snapshot(g, LIMITS)).balances.operating).toBe(6900)
      })

      test('settling returns what was reserved but not spent, and counts only the actual spend', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 500)
        const settled = await store.settleSpend(g, reserved.id, 320)
        expect(settled).toMatchObject({ ok: true, spend: { status: 'settled', settledCents: 320 } })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap.balances.operating).toBe(6680)
        expect(snap.spentTodayCents).toBe(320)
        expect(await store.settleSpend(g, reserved.id, 320)).toMatchObject({ ok: true })
        expect(await store.settleSpend(g, reserved.id, 100)).toEqual({
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
        expect(await store.settleSpend(g, reserved.id, 501)).toEqual({
          ok: false,
          reason: 'exceeds_reserved',
        })
        expect(await store.settleSpend(g, waiting.id, 100)).toEqual({
          ok: false,
          reason: 'wrong_state',
        })
        expect(await store.settleSpend(g, reserved.id, -1)).toEqual({
          ok: false,
          reason: 'invalid_amount',
        })
      })

      test('releasing a reservation frees all of it and is idempotent', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const reserved = await request(store, g, 'r', 500)
        expect(await store.releaseSpend(g, reserved.id)).toMatchObject({
          ok: true,
          spend: { status: 'released' },
        })
        expect(await store.releaseSpend(g, reserved.id)).toMatchObject({ ok: true })
        const snap = await store.snapshot(g, LIMITS)
        expect(snap).toMatchObject({ spentTodayCents: 0 })
        expect(snap.balances.operating).toBe(7000)
        const other = await request(store, g, 's', 100)
        await store.settleSpend(g, other.id, 100)
        expect(await store.releaseSpend(g, other.id)).toEqual({ ok: false, reason: 'wrong_state' })
      })
    })

    describe('reserve', () => {
      test('the reserve moves to operating only by an explicit release, once per key', async () => {
        const { store, newGuild } = await make()
        const g = await newGuild()
        const input = { key: 'r1', amountCents: 1000 }
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
        expect(await store.releaseReserve(g, { key: 'a', amountCents: 3001 }, LIMITS)).toEqual({
          ok: false,
          reason: 'insufficient_funds',
        })
        expect(await store.releaseReserve(g, { key: 'b', amountCents: 0 }, LIMITS)).toEqual({
          ok: false,
          reason: 'invalid_amount',
        })
      })
    })
  })
}
