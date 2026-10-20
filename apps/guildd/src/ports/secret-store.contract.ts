import { describe, expect, test } from 'bun:test'
import { SecretExistsError, type SecretStore } from './secret-store'

/** A store under test plus a window onto what it keeps at rest. */
export interface SecretStoreFixture {
  store: SecretStore
  /** Guilds the fixture may use (a database-backed store needs real guilds). */
  newGuild: () => Promise<string>
  /** The stored bytes for a secret (what sits on disk), or null when absent. */
  stored: (guildId: string, ref: string) => Promise<Uint8Array | null>
}

const contains = (haystack: Uint8Array, needle: string) =>
  Buffer.from(haystack).includes(Buffer.from(needle))

/** The SecretStore contract, run against every adapter. `make` returns a fresh store. */
export function secretStoreContract(name: string, make: () => Promise<SecretStoreFixture>) {
  describe(`SecretStore contract: ${name}`, () => {
    test('a stored secret resolves to its value, and the row is ciphertext', async () => {
      const { store, stored, newGuild } = await make()
      const guild = await newGuild()
      await store.add(guild, 'openai', 'sk-live-ABC123')
      expect(await store.resolve(guild, 'openai')).toBe('sk-live-ABC123')
      const raw = await stored(guild, 'openai')
      expect(raw).not.toBeNull()
      expect(contains(raw ?? new Uint8Array(), 'sk-live-ABC123')).toBe(false)
    })

    test('the same value stored twice seals differently (fresh nonce)', async () => {
      const { store, stored, newGuild } = await make()
      const guild = await newGuild()
      await store.add(guild, 'one', 'same-value-xyz')
      await store.add(guild, 'two', 'same-value-xyz')
      const one = Buffer.from((await stored(guild, 'one')) ?? [])
      const two = Buffer.from((await stored(guild, 'two')) ?? [])
      expect(one.length).toBeGreaterThan(0)
      expect(one.equals(two)).toBe(false)
    })

    test('adding an existing ref is refused and keeps the original', async () => {
      const { store, newGuild } = await make()
      const guild = await newGuild()
      await store.add(guild, 'openai', 'first')
      await expect(store.add(guild, 'openai', 'second')).rejects.toBeInstanceOf(SecretExistsError)
      expect(await store.resolve(guild, 'openai')).toBe('first')
    })

    test('check reports resolved or missing for each ref', async () => {
      const { store, newGuild } = await make()
      const guild = await newGuild()
      await store.add(guild, 'openai', 'v')
      expect(await store.check(guild, ['openai', 'nope'])).toEqual([
        { ref: 'openai', status: 'resolved' },
        { ref: 'nope', status: 'missing' },
      ])
    })

    test('list is paginated in ref order and carries no values', async () => {
      const { store, newGuild } = await make()
      const guild = await newGuild()
      for (const ref of ['c', 'a', 'b']) {
        await store.add(guild, ref, `value-${ref}`)
      }
      expect(await store.list(guild, { limit: 2 })).toEqual({ refs: ['a', 'b'], next: 'b' })
      expect(await store.list(guild, { after: 'b', limit: 2 })).toEqual({
        refs: ['c'],
        next: null,
      })
    })

    test("another guild cannot see, check or resolve a guild's secret", async () => {
      const { store, stored, newGuild } = await make()
      const guildA = await newGuild()
      const guildB = await newGuild()
      await store.add(guildA, 'openai', 'only-for-A')
      expect(await store.resolve(guildB, 'openai')).toBeNull()
      expect(await store.check(guildB, ['openai'])).toEqual([{ ref: 'openai', status: 'missing' }])
      expect(await store.list(guildB, { limit: 10 })).toEqual({ refs: [], next: null })
      expect(await stored(guildB, 'openai')).toBeNull()
      await store.add(guildB, 'openai', 'only-for-B')
      expect(await store.resolve(guildA, 'openai')).toBe('only-for-A')
      expect(await store.resolve(guildB, 'openai')).toBe('only-for-B')
    })
  })
}
