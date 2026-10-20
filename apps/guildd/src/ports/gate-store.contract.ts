import { describe, expect, test } from 'bun:test'
import type { GateStore } from './gate-store'

const GM = crypto.randomUUID()

/** A store under test; a database-backed store needs real guilds. */
export interface GateStoreFixture {
  store: GateStore
  newGuild: () => Promise<string>
  /** The `gates.*` event types appended to the guild's chain so far, in order. */
  events: (guildId: string) => Promise<string[]>
}

/**
 * The GateStore contract, run against every adapter. `make` returns a fresh store. A global bar is
 * shared state, so every test that sets one lifts it again before it ends.
 */
export function gateStoreContract(name: string, make: () => Promise<GateStoreFixture>) {
  describe(`GateStore contract: ${name}`, () => {
    test('barring a guild is immediate, affects only that guild, and lifting clears it', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      expect(await store.isBarred(a)).toBe(false)
      const first = await store.bar({ guildId: a, memberId: GM }, 'guild')
      expect(first.created).toBe(true)
      expect(await store.isBarred(a)).toBe(true)
      expect(await store.isBarred(b)).toBe(false)
      expect(await store.status(a)).toEqual({ guild: true, global: false })
      expect(await store.lift({ guildId: a, memberId: GM }, 'guild')).toBe(first.barId)
      expect(await store.isBarred(a)).toBe(false)
      expect(await store.lift({ guildId: a, memberId: GM }, 'guild')).toBeNull()
    })

    test('a global bar stops every guild and a guild lift does not clear it', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      try {
        await store.bar({ guildId: a, memberId: GM }, 'global')
        expect(await store.isBarred(a)).toBe(true)
        expect(await store.isBarred(b)).toBe(true)
        expect(await store.status(b)).toEqual({ guild: false, global: true })
        await store.bar({ guildId: b, memberId: GM }, 'guild')
        await store.lift({ guildId: b, memberId: GM }, 'guild')
        expect(await store.isBarred(b)).toBe(true)
      } finally {
        await store.lift({ guildId: a, memberId: GM }, 'global')
      }
      expect(await store.isBarred(a)).toBe(false)
      expect(await store.isBarred(b)).toBe(false)
    })

    test('a bar is made once, even same-tick, and is one chained event with ids only', async () => {
      const { store, newGuild, events } = await make()
      const g = await newGuild()
      const results = await Promise.all(
        Array.from({ length: 5 }, () => store.bar({ guildId: g, memberId: GM }, 'guild'))
      )
      expect(results.filter((r) => r.created)).toHaveLength(1)
      expect(new Set(results.map((r) => r.barId)).size).toBe(1)
      expect(await events(g)).toEqual(['gates.barred'])
      await store.lift({ guildId: g, memberId: GM }, 'guild')
      expect(await events(g)).toEqual(['gates.barred', 'gates.lifted'])
    })

    test('a global bar and lift are chained in the acting guild only', async () => {
      const { store, newGuild, events } = await make()
      const actor = await newGuild()
      const other = await newGuild()
      try {
        await store.bar({ guildId: actor, memberId: GM }, 'global')
      } finally {
        await store.lift({ guildId: actor, memberId: GM }, 'global')
      }
      expect(await events(actor)).toEqual(['gates.barred', 'gates.lifted'])
      expect(await events(other)).toEqual([])
    })

    test('a global bar and lift are announced once to every other guild chain, never twice', async () => {
      const { store, newGuild, events } = await make()
      const actor = await newGuild()
      const other = await newGuild()
      const { barId } = await store.bar({ guildId: actor, memberId: GM }, 'global')
      try {
        const barred = { type: 'gates.barred', barId, memberId: GM } as const
        expect(await store.announceGlobal(other, barred)).toBe(true)
        expect(await store.announceGlobal(other, barred)).toBe(false)
        expect(await store.announceGlobal(actor, barred)).toBe(false)
        const same = await Promise.all([1, 2, 3].map(() => store.announceGlobal(other, barred)))
        expect(same.filter(Boolean)).toHaveLength(0)
      } finally {
        await store.lift({ guildId: actor, memberId: GM }, 'global')
      }
      const lifted = { type: 'gates.lifted', barId, memberId: GM } as const
      expect(await store.announceGlobal(other, lifted)).toBe(true)
      expect(await store.announceGlobal(other, lifted)).toBe(false)
      expect(await events(other)).toEqual(['gates.barred', 'gates.lifted'])
      expect(await events(actor)).toEqual(['gates.barred', 'gates.lifted'])
    })

    test("the latest global lift is remembered in the acting guild's chain only", async () => {
      const { store, newGuild } = await make()
      const actor = await newGuild()
      const other = await newGuild()
      expect(await store.latestGlobalLift(actor)).toBeNull()
      const first = await store.bar({ guildId: actor, memberId: GM }, 'global')
      expect(await store.lift({ guildId: actor, memberId: GM }, 'global')).toBe(first.barId)
      const second = await store.bar({ guildId: actor, memberId: GM }, 'global')
      expect(await store.latestGlobalLift(actor)).toBe(first.barId)
      expect(await store.lift({ guildId: actor, memberId: GM }, 'global')).toBe(second.barId)
      expect(await store.latestGlobalLift(actor)).toBe(second.barId)
      expect(await store.latestGlobalLift(other)).toBeNull()
    })
  })
}
