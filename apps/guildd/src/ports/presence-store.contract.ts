import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { isAway, type PresenceStore } from './presence-store'

/** A store under test, its controllable clock, and a way to get guilds. */
export interface PresenceStoreFixture {
  store: PresenceStore
  clock: MemoryClock
  newGuild: () => Promise<string>
}

/** The PresenceStore contract, run against every adapter. `make` returns a fresh store. */
export function presenceStoreContract(name: string, make: () => Promise<PresenceStoreFixture>) {
  describe(`PresenceStore contract: ${name}`, () => {
    test('a guild that never went away is present', async () => {
      const { store, clock, newGuild } = await make()
      const state = await store.get(await newGuild())
      expect(state).toEqual({ away: false, since: null, until: null })
      expect(isAway(state, clock.now())).toBe(false)
    })

    test('going away records since and the optional return time', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const until = new Date(clock.now().getTime() + 3_600_000).toISOString()
      const state = await store.goAway(g, until)
      expect(state).toEqual({ away: true, since: clock.now().toISOString(), until })
      expect(await store.get(g)).toEqual(state)
      expect(isAway(state, clock.now())).toBe(true)
    })

    test('going away with no return time stays away until the Guild Master returns', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const state = await store.goAway(g, null)
      expect(state.until).toBeNull()
      clock.advance(30 * 86_400_000)
      expect(isAway(await store.get(g), clock.now())).toBe(true)
    })

    test('going away again keeps the original since and replaces the return time', async () => {
      const { store, clock, newGuild } = await make()
      const g = await newGuild()
      const first = await store.goAway(g, null)
      clock.advance(60_000)
      const until = new Date(clock.now().getTime() + 60_000).toISOString()
      expect(await store.goAway(g, until)).toEqual({ away: true, since: first.since, until })
    })

    test('returning clears the state and reports whether anything changed', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.returnHome(g)).toBe(false)
      await store.goAway(g, null)
      expect(await store.returnHome(g)).toBe(true)
      expect(await store.get(g)).toEqual({ away: false, since: null, until: null })
      expect(await store.returnHome(g)).toBe(false)
    })

    test('guilds do not see or change each other', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.goAway(a, null)
      expect((await store.get(b)).away).toBe(false)
      expect(await store.returnHome(b)).toBe(false)
      expect((await store.get(a)).away).toBe(true)
    })
  })
}

describe('isAway', () => {
  const now = new Date('2026-01-01T12:00:00.000Z')
  test('a passed return time counts as present; a future or open one counts as away', () => {
    const since = '2026-01-01T00:00:00.000Z'
    expect(isAway({ away: true, since, until: '2026-01-01T11:59:59.000Z' }, now)).toBe(false)
    expect(isAway({ away: true, since, until: now.toISOString() }, now)).toBe(false)
    expect(isAway({ away: true, since, until: '2026-01-01T12:00:01.000Z' }, now)).toBe(true)
    expect(isAway({ away: true, since, until: null }, now)).toBe(true)
    expect(isAway({ away: false, since: null, until: null }, now)).toBe(false)
  })
})
