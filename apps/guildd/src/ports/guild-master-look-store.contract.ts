import { describe, expect, test } from 'bun:test'
import type { CharacterLook } from '../look-catalogue'
import type { GuildMasterLookStore } from './guild-master-look-store'

/** A store under test. */
export interface GuildMasterLookStoreFixture {
  store: GuildMasterLookStore
  newGuild: () => Promise<string>
}

const knight: CharacterLook = {
  body: 2,
  outfitStyle: 4,
  outfitColor: 1,
  hairStyle: 0,
  hairColor: 7,
}
const mage: CharacterLook = { body: 0, outfitStyle: 9, outfitColor: 5, hairStyle: 1, hairColor: 3 }

/** The GuildMasterLookStore contract, run against every adapter. */
export function guildMasterLookStoreContract(
  name: string,
  make: () => Promise<GuildMasterLookStoreFixture>
) {
  describe(`GuildMasterLookStore contract: ${name}`, () => {
    test('a guild with no saved look has none', async () => {
      const { store, newGuild } = await make()
      expect(await store.get(await newGuild())).toBeNull()
    })

    test('a saved look is read back, and saving again replaces it', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.set(g, knight)
      expect(await store.get(g)).toEqual(knight)
      await store.set(g, mage)
      expect(await store.get(g)).toEqual(mage)
    })

    test('racing saves leave exactly one of them stored', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await Promise.all([store.set(g, knight), store.set(g, mage)])
      const kept = JSON.stringify(await store.get(g))
      expect([JSON.stringify(knight), JSON.stringify(mage)]).toContain(kept)
    })

    test('guilds keep their own looks', async () => {
      const { store, newGuild } = await make()
      const a = await newGuild()
      const b = await newGuild()
      await store.set(a, knight)
      expect(await store.get(b)).toBeNull()
      await store.set(b, mage)
      expect(await store.get(a)).toEqual(knight)
    })
  })
}
