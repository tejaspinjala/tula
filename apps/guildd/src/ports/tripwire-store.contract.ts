import { describe, expect, test } from 'bun:test'
import type { NewPause, TripwireStore } from './tripwire-store'

/** A store under test; a database-backed store needs real guilds. */
export interface TripwireStoreFixture {
  store: TripwireStore
  newGuild: () => Promise<string>
  /** The Hall event types appended for the guild so far, in order. */
  events: (guildId: string) => Promise<string[]>
}

const pause = (hallId: string, over: Partial<NewPause> = {}): NewPause => ({
  hallId,
  tripwire: 'gate_denials',
  observed: 12,
  threshold: 10,
  ...over,
})

/** The TripwireStore contract, run against every adapter. `make` returns a fresh store. */
export function tripwireStoreContract(name: string, make: () => Promise<TripwireStoreFixture>) {
  describe(`TripwireStore contract: ${name}`, () => {
    test('pausing is immediate and visible, and resuming lifts it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.isPaused(g, 'heralds')).toBe(false)
      const { pause: p, created } = await store.pause(g, pause('heralds'))
      expect(created).toBe(true)
      expect(p).toMatchObject({ hallId: 'heralds', tripwire: 'gate_denials', observed: 12 })
      expect(await store.isPaused(g, 'heralds')).toBe(true)
      expect(await store.isPaused(g, 'other')).toBe(false)
      expect(await store.resume(g, 'heralds')).toBe(true)
      expect(await store.isPaused(g, 'heralds')).toBe(false)
      expect(await store.resume(g, 'heralds')).toBe(false)
    })

    test('a Hall is paused once, even same-tick, and the pause is one chained event', async () => {
      const { store, newGuild, events } = await make()
      const g = await newGuild()
      const results = await Promise.all(
        Array.from({ length: 6 }, () => store.pause(g, pause('heralds', { tripwire: 'loop' })))
      )
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.pause.id)).size).toBe(1)
      expect((await store.list(g, { limit: 10 })).pauses).toHaveLength(1)
      await store.resume(g, 'heralds')
      await store.resume(g, 'heralds')
      expect(await events(g)).toEqual(['hall.paused', 'hall.resumed'])
    })

    test('lists active pauses oldest first, paginated', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const h of ['a', 'b', 'c']) {
        await store.pause(g, pause(h))
      }
      await store.resume(g, 'b')
      const first = await store.list(g, { limit: 1 })
      expect(first.pauses.map((p) => p.hallId)).toEqual(['a'])
      expect(first.next).not.toBeNull()
      const second = await store.list(g, { after: first.next ?? 0, limit: 1 })
      expect(second.pauses.map((p) => p.hallId)).toEqual(['c'])
      expect(second.next).toBeNull()
    })

    test('a Hall can be paused again after a resume', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const first = await store.pause(g, pause('heralds'))
      await store.resume(g, 'heralds')
      const again = await store.pause(g, pause('heralds', { tripwire: 'token_burn' }))
      expect(again.created).toBe(true)
      expect(again.pause.id).not.toBe(first.pause.id)
    })

    test("another guild cannot see or lift a guild's pauses", async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.pause(a, pause('heralds'))
      expect(await store.isPaused(b, 'heralds')).toBe(false)
      expect((await store.list(b, { limit: 10 })).pauses).toEqual([])
      expect(await store.resume(b, 'heralds')).toBe(false)
      expect(await store.isPaused(a, 'heralds')).toBe(true)
      const bPause = await store.pause(b, pause('heralds'))
      expect(bPause.created).toBe(true)
    })
  })
}
