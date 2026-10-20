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
  })
}
