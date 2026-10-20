import { describe, expect, test } from 'bun:test'
import type { ToolsetStore } from './toolset-store'

/** A store under test. */
export interface ToolsetStoreFixture {
  store: ToolsetStore
  newGuild: () => Promise<string>
}

/** The ToolsetStore contract, run against every adapter. */
export function toolsetStoreContract(name: string, make: () => Promise<ToolsetStoreFixture>) {
  describe(`ToolsetStore contract: ${name}`, () => {
    test('the first list frozen for a scope and role wins and keeps its order', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.freeze(g, 'camp', 'adept', ['b', 'a'])).toEqual(['b', 'a'])
      expect(await store.freeze(g, 'camp', 'adept', ['a', 'b', 'c'])).toEqual(['b', 'a'])
    })

    test('racing freezes agree on one list', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const lists = await Promise.all(
        ['x', 'y', 'z', 'w'].map((t) => store.freeze(g, 'camp', 'adept', [t]))
      )
      expect(new Set(lists.map((l) => l.join())).size).toBe(1)
    })

    test('scopes, roles and guilds freeze independently', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.freeze(a, 'camp', 'adept', ['one'])
      expect(await store.freeze(a, 'camp', 'apprentice', ['two'])).toEqual(['two'])
      expect(await store.freeze(a, 'other', 'adept', ['three'])).toEqual(['three'])
      expect(await store.freeze(b, 'camp', 'adept', ['four'])).toEqual(['four'])
    })
  })
}
