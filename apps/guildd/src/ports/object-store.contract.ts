import { describe, expect, test } from 'bun:test'
import type { ObjectStore } from './object-store'

const bytes = (text: string) => new TextEncoder().encode(text)
const text = (data: Uint8Array | null) => (data ? new TextDecoder().decode(data) : null)

/**
 * The ObjectStore contract, run against every adapter (memory in verify, MinIO in
 * `bun run test:integration`). `make` returns a fresh, empty store and `countObjects` reports how
 * many objects it holds in total, so dedupe is observable.
 */
export function objectStoreContract(
  name: string,
  make: () => Promise<{ store: ObjectStore; countObjects: () => Promise<number> }>
) {
  describe(`ObjectStore contract: ${name}`, () => {
    const guildA = crypto.randomUUID()
    const guildB = crypto.randomUUID()

    test('putting the same bytes twice yields the same hash and one stored object', async () => {
      const { store, countObjects } = await make()
      const first = await store.put(guildA, bytes('hello'))
      const second = await store.put(guildA, bytes('hello'))
      expect(first).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
      expect(second).toBe(first)
      expect(await countObjects()).toBe(1)
    })

    test('get returns identical bytes and head their size; an unknown hash is null', async () => {
      const { store } = await make()
      const raw = new Uint8Array([0, 255, 1, 254, 10, 13])
      const hash = await store.put(guildA, raw)
      expect([...((await store.get(guildA, hash)) ?? [])]).toEqual([...raw])
      expect(await store.head(guildA, hash)).toEqual({ size: 6 })
      const unknown = '0'.repeat(64)
      expect(await store.get(guildA, unknown)).toBeNull()
      expect(await store.head(guildA, unknown)).toBeNull()
    })

    test("guild B cannot fetch guild A's bytes by hash", async () => {
      const { store } = await make()
      const hash = await store.put(guildA, bytes('secret'))
      expect(await store.get(guildB, hash)).toBeNull()
      expect(await store.head(guildB, hash)).toBeNull()
      expect(text(await store.get(guildA, hash))).toBe('secret')
    })

    test('path-traversal and slash-bearing ids are rejected and never reach another guild', async () => {
      const { store } = await make()
      const hash = await store.put(guildB, bytes('B-private'))
      const attacks: Array<[string, string]> = [
        [`${guildA}/../${guildB}`, hash],
        [guildA, `../${guildB}/${hash}`],
        [`${guildA}/x`, hash],
        [guildA, `${hash}/..`],
        [guildA, hash.toUpperCase()],
        ['not-a-uuid', hash],
      ]
      for (const [g, h] of attacks) {
        const got = await store.get(g, h).catch(() => null)
        expect(got).toBeNull()
        expect(await store.head(g, h).catch(() => null)).toBeNull()
      }
      await expect(store.put(`${guildA}/../${guildB}`, bytes('x'))).rejects.toThrow()
      await expect(store.get(guildA, `../${guildB}/${hash}`)).rejects.toThrow()
      await expect(store.head(guildA, 'abc')).rejects.toThrow()
    })
  })
}
