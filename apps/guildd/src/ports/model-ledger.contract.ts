import { describe, expect, test } from 'bun:test'
import type { ModelLedger, NewRun, UsageEntry } from './model-ledger'

/** A ledger under test; a database-backed ledger needs real guilds. */
export interface ModelLedgerFixture {
  ledger: ModelLedger
  newGuild: () => Promise<string>
}

const DAY = '2026-03-04'
const run = (runId: string, over: Partial<NewRun> = {}): NewRun => ({
  runId,
  questId: 'quest-1',
  attempt: 1,
  hallId: 'heralds',
  providerId: 'cloud',
  profileId: 'cloud-mid',
  state: 'active',
  tokenHash: `hash-${runId}`,
  expiresAt: '2026-03-04T12:00:00.000Z',
  ...over,
})
const usage = (callKey: string, runId: string, over: Partial<UsageEntry> = {}): UsageEntry => ({
  callKey,
  runId,
  day: DAY,
  inputTokens: 100,
  outputTokens: 50,
  costMicros: 1000,
  ...over,
})

const HUGE = { tokens: 1_000_000_000, costMicros: 1_000_000_000 }

/** Charges `entry` as a reservation under huge caps, then settles it to the same figures. */
async function record(ledger: ModelLedger, g: string, entry: UsageEntry): Promise<void> {
  const r = await ledger.reserve(g, { ...entry, clientKey: null, caps: HUGE })
  if (r.status !== 'reserved') {
    throw new Error(`expected reserved, got ${r.status}`)
  }
  await ledger.settle(g, entry.callKey, entry)
}

/** The ModelLedger contract, run against every adapter. `make` returns a fresh ledger. */
export function modelLedgerContract(name: string, make: () => Promise<ModelLedgerFixture>) {
  describe(`ModelLedger contract: ${name}`, () => {
    test('a run is found by its token hash; an unknown hash finds nothing', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      expect(await ledger.openRun(g, run('r1'))).toBe('created')
      expect(await ledger.findByTokenHash(g, 'hash-r1')).toMatchObject({
        runId: 'r1',
        questId: 'quest-1',
        state: 'active',
        expiresAt: '2026-03-04T12:00:00.000Z',
      })
      expect(await ledger.findByTokenHash(g, 'hash-other')).toBeNull()
    })

    test('opening the same run twice, even in the same tick, creates it once', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      const results = await Promise.all([
        ledger.openRun(g, run('r1')),
        ledger.openRun(g, run('r1')),
      ])
      expect(results.sort()).toEqual(['created', 'exists'])
    })

    test('revoking a run marks it revoked and reports unknown runs', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      expect(await ledger.revoke(g, 'r1')).toBe(true)
      expect((await ledger.findByTokenHash(g, 'hash-r1'))?.state).toBe('revoked')
      expect(await ledger.revoke(g, 'nope')).toBe(false)
    })

    test('only a run revoked by a Hall pause can be reactivated; a manual revoke is final', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      const exp = '2026-03-04T13:00:00.000Z'
      await ledger.openRun(g, run('paused'))
      await ledger.openRun(g, run('manual'))
      await ledger.revoke(g, 'manual')
      expect(await ledger.revokeHallRuns(g, 'heralds')).toBe(1)
      expect((await ledger.getRun(g, 'paused'))?.revokeReason).toBe('hall_paused')
      expect((await ledger.getRun(g, 'manual'))?.revokeReason).toBe('manual')
      expect(await ledger.activate(g, 'manual', 'hash-m', exp)).toBe(false)
      expect(await ledger.activate(g, 'paused', 'hash-p', exp)).toBe(true)
      expect((await ledger.getRun(g, 'paused'))?.revokeReason).toBeNull()
    })

    test('a queued run activates once with a fresh token, even in the same tick', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('q1', { state: 'queued', tokenHash: null, expiresAt: null }))
      expect((await ledger.listQueued(g, 10)).map((r) => r.runId)).toEqual(['q1'])
      const exp = '2026-03-04T13:00:00.000Z'
      const flips = await Promise.all([
        ledger.activate(g, 'q1', 'hash-a', exp),
        ledger.activate(g, 'q1', 'hash-b', exp),
      ])
      expect(flips.filter(Boolean)).toHaveLength(1)
      expect(await ledger.listQueued(g, 10)).toEqual([])
      expect((await ledger.getRun(g, 'q1'))?.state).toBe('active')
    })

    test('usage totals per guild-day', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      await record(ledger, g, usage('c1', 'r1'))
      await record(ledger, g, usage('c2', 'r1', { costMicros: null, inputTokens: 10 }))
      await record(ledger, g, usage('c3', 'r1', { day: '2026-03-05' }))
      expect(await ledger.dayTotals(g, DAY)).toEqual({ tokens: 150 + 60, costMicros: 1000 })
      expect(await ledger.dayTotals(g, '2026-03-06')).toEqual({ tokens: 0, costMicros: 0 })
    })

    test('parallel reservations against a cap that admits one: exactly one is reserved', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      const caps = { tokens: 200, costMicros: 1_000_000 }
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((k) =>
          ledger.reserve(g, { ...usage(k, 'r1'), clientKey: null, caps })
        )
      )
      expect(results.filter((r) => r.status === 'reserved')).toHaveLength(1)
      expect(results.filter((r) => r.status === 'cap_reached')).toHaveLength(3)
      expect((await ledger.dayTotals(g, DAY)).tokens).toBe(150)
    })

    test('a cap refusal names the cap and charges nothing; spend caps count dollars', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      const spend = await ledger.reserve(g, {
        ...usage('a', 'r1'),
        clientKey: null,
        caps: { tokens: 1_000_000, costMicros: 999 },
      })
      expect(spend).toEqual({ status: 'cap_reached', reason: 'daily_spend' })
      const tokens = await ledger.reserve(g, {
        ...usage('b', 'r1'),
        clientKey: null,
        caps: { tokens: 149, costMicros: 1_000_000 },
      })
      expect(tokens).toEqual({ status: 'cap_reached', reason: 'daily_tokens' })
      expect(await ledger.dayTotals(g, DAY)).toEqual({ tokens: 0, costMicros: 0 })
    })

    test('an unsettled reservation keeps its estimate; settling replaces it with actual usage', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      await ledger.reserve(g, { ...usage('a', 'r1'), clientKey: null, caps: HUGE })
      expect(await ledger.dayTotals(g, DAY)).toEqual({ tokens: 150, costMicros: 1000 })
      await ledger.settle(g, 'a', { inputTokens: 10, outputTokens: 5, costMicros: 40 })
      expect(await ledger.dayTotals(g, DAY)).toEqual({ tokens: 15, costMicros: 40 })
    })

    test('a client key is scoped to its run: reuse is a duplicate, other runs are unaffected', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      await ledger.openRun(g, run('r2', { tokenHash: 'h2' }))
      const reserve = (callKey: string, runId: string) =>
        ledger.reserve(g, { ...usage(callKey, runId), clientKey: 'same', caps: HUGE })
      const same = await Promise.all([reserve('a', 'r1'), reserve('b', 'r1')])
      expect(same.map((r) => r.status).sort()).toEqual(['duplicate', 'reserved'])
      expect((await reserve('c', 'r2')).status).toBe('reserved')
      expect((await ledger.dayTotals(g, DAY)).tokens).toBe(300)
    })

    test('a garbage day cursor yields an empty page instead of throwing', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1'))
      await record(ledger, g, usage('a', 'r1'))
      for (const after of ['garbage', '2026-13-45', '1']) {
        expect(await ledger.report(g, 'day', { after, limit: 10 })).toEqual({
          rows: [],
          next: null,
        })
      }
    })

    test('usage for an unknown run is refused', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await expect(record(ledger, g, usage('c1', 'ghost'))).rejects.toThrow()
    })

    test('the cost table groups by run, Quest, Hall and day, paginated', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      await ledger.openRun(g, run('r1', { questId: 'qa', hallId: 'heralds' }))
      await ledger.openRun(g, run('r2', { questId: 'qa', hallId: 'heralds', tokenHash: 'h2' }))
      await ledger.openRun(g, run('r3', { questId: 'qb', hallId: 'scribes', tokenHash: 'h3' }))
      await record(ledger, g, usage('a', 'r1'))
      await record(ledger, g, usage('b', 'r2'))
      await record(ledger, g, usage('c', 'r3', { day: '2026-03-05', costMicros: 500 }))

      const byQuest = await ledger.report(g, 'quest', { limit: 10 })
      expect(byQuest.rows).toEqual([
        { key: 'qa', calls: 2, inputTokens: 200, outputTokens: 100, costMicros: 2000 },
        { key: 'qb', calls: 1, inputTokens: 100, outputTokens: 50, costMicros: 500 },
      ])
      expect((await ledger.report(g, 'hall', { limit: 10 })).rows.map((r) => r.key)).toEqual([
        'heralds',
        'scribes',
      ])
      expect((await ledger.report(g, 'day', { limit: 10 })).rows.map((r) => r.key)).toEqual([
        DAY,
        '2026-03-05',
      ])
      const runs = await ledger.report(g, 'run', { limit: 2 })
      expect(runs.rows.map((r) => r.key)).toEqual(['r1', 'r2'])
      expect(runs.next).toBe('r2')
      const rest = await ledger.report(g, 'run', { after: runs.next ?? '', limit: 2 })
      expect(rest.rows.map((r) => r.key)).toEqual(['r3'])
      expect(rest.next).toBeNull()
    })

    test('the cap notice is first for a guild-day only, even in the same tick', async () => {
      const { ledger, newGuild } = await make()
      const g = await newGuild()
      const first = await Promise.all([
        ledger.noteCapReached(g, DAY, 'daily_spend'),
        ledger.noteCapReached(g, DAY, 'daily_spend'),
      ])
      expect(first.filter(Boolean)).toHaveLength(1)
      expect(await ledger.noteCapReached(g, '2026-03-05', 'daily_tokens')).toBe(true)
    })

    test("another guild cannot see a guild's runs, tokens or spend", async () => {
      const { ledger, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await ledger.openRun(a, run('r1'))
      await record(ledger, a, usage('c1', 'r1'))
      expect(await ledger.findByTokenHash(b, 'hash-r1')).toBeNull()
      expect(await ledger.getRun(b, 'r1')).toBeNull()
      expect(await ledger.revoke(b, 'r1')).toBe(false)
      expect(await ledger.dayTotals(b, DAY)).toEqual({ tokens: 0, costMicros: 0 })
      expect((await ledger.report(b, 'run', { limit: 10 })).rows).toEqual([])
      expect(await ledger.openRun(b, run('r1', { tokenHash: 'hash-b' }))).toBe('created')
      expect(await ledger.noteCapReached(a, DAY, 'x')).toBe(true)
      expect(await ledger.noteCapReached(b, DAY, 'x')).toBe(true)
    })
  })
}
