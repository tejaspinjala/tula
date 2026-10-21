import { describe, expect, test } from 'bun:test'
import type { RoutingEntry, RoutingLog } from './routing-log'

/** A log under test; a database-backed log needs real guilds. */
export interface RoutingLogFixture {
  log: RoutingLog
  newGuild: () => Promise<string>
}

const entry = (decisionKey: string, over: Partial<RoutingEntry> = {}): RoutingEntry => ({
  decisionKey,
  source: 'template',
  goalSha256: null,
  hallId: 'heralds',
  rank: 'journeyman',
  dataClass: 'internal',
  classifierClaim: null,
  outcome: 'routed',
  providerId: 'cloud',
  profileId: 'cloud-mid',
  reason: null,
  ...over,
})

/** The RoutingLog contract, run against every adapter. `make` returns a fresh log. */
export function routingLogContract(name: string, make: () => Promise<RoutingLogFixture>) {
  describe(`RoutingLog contract: ${name}`, () => {
    test('records decisions and lists them newest first, paginated', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      for (const k of ['a', 'b', 'c']) {
        await log.record(g, entry(k))
      }
      const first = await log.list(g, { limit: 2 })
      expect(first.entries.map((e) => e.decisionKey)).toEqual(['c', 'b'])
      expect(first.next).not.toBeNull()
      const second = await log.list(g, { after: first.next ?? 0, limit: 2 })
      expect(second.entries.map((e) => e.decisionKey)).toEqual(['a'])
      expect(second.next).toBeNull()
    })

    test('forKeys returns only the named decisions of its own guild', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      const other = await newGuild()
      for (const k of ['a', 'b', 'c']) {
        await log.record(g, entry(k))
      }
      await log.record(other, entry('a'))
      const found = await log.forKeys(g, ['a', 'c', 'zzz'])
      expect(found.map((e) => e.decisionKey).sort()).toEqual(['a', 'c'])
      expect(await log.forKeys(g, [])).toEqual([])
    })

    test('a blocked decision and a classifier claim round-trip', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      const blocked = entry('k', {
        source: 'classifier',
        goalSha256: 'a'.repeat(64),
        classifierClaim: { hallId: 'vault', rank: 'adept', dataClass: 'public' },
        dataClass: 'private',
        outcome: 'blocked',
        providerId: null,
        profileId: null,
        reason: 'private_provider_unavailable',
      })
      await log.record(g, blocked)
      const { entries } = await log.list(g, { limit: 5 })
      expect(entries[0]).toMatchObject(blocked)
    })

    test('a repeated decision key logs once, even in the same tick', async () => {
      const { log, newGuild } = await make()
      const g = await newGuild()
      await Promise.all([log.record(g, entry('same')), log.record(g, entry('same'))])
      expect((await log.list(g, { limit: 10 })).entries).toHaveLength(1)
    })

    test("another guild cannot see a guild's decisions, and keys do not collide", async () => {
      const { log, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await log.record(a, entry('shared-key', { hallId: 'a-secret-hall' }))
      expect((await log.list(b, { limit: 10 })).entries).toEqual([])
      await log.record(b, entry('shared-key', { hallId: 'b-hall' }))
      expect((await log.list(a, { limit: 10 })).entries.map((e) => e.hallId)).toEqual([
        'a-secret-hall',
      ])
      expect((await log.list(b, { limit: 10 })).entries.map((e) => e.hallId)).toEqual(['b-hall'])
    })
  })
}
