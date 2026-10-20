import { describe, expect, test } from 'bun:test'
import type { KeyProvider } from './key-provider'

const bytes = (text: string) => new TextEncoder().encode(text)

/**
 * The KeyProvider contract, run against every adapter. `make` returns a provider plus `reopen`,
 * which builds a second instance over the same key custody (as after a restart).
 */
export function keyProviderContract(
  name: string,
  make: () => Promise<{ provider: KeyProvider; reopen: () => Promise<KeyProvider> }>
) {
  describe(`KeyProvider contract: ${name}`, () => {
    const guildA = crypto.randomUUID()
    const guildB = crypto.randomUUID()

    test('mac is 64 lowercase hex chars and deterministic, also after reopening', async () => {
      const { provider, reopen } = await make()
      const first = await provider.mac(guildA, 'audit', bytes('x'))
      expect(first).toMatch(/^[0-9a-f]{64}$/)
      expect(await provider.mac(guildA, 'audit', bytes('x'))).toBe(first)
      expect(await (await reopen()).mac(guildA, 'audit', bytes('x'))).toBe(first)
    })

    test('mac differs by guild, purpose and data', async () => {
      const { provider } = await make()
      const base = await provider.mac(guildA, 'audit', bytes('x'))
      expect(await provider.mac(guildB, 'audit', bytes('x'))).not.toBe(base)
      expect(await provider.mac(guildA, 'other', bytes('x'))).not.toBe(base)
      expect(await provider.mac(guildA, 'audit', bytes('y'))).not.toBe(base)
    })

    test('two independent custodies disagree on the same mac', async () => {
      const one = await make()
      const two = await make()
      expect(await one.provider.mac(guildA, 'audit', bytes('x'))).not.toBe(
        await two.provider.mac(guildA, 'audit', bytes('x'))
      )
    })

    test('wrap then unwrap round-trips, also after reopening; wrapping is randomised', async () => {
      const { provider, reopen } = await make()
      const secret = new Uint8Array([0, 1, 2, 255, 254])
      const wrapped = await provider.wrap(guildA, secret)
      expect([...wrapped]).not.toEqual([...secret])
      expect([...(await provider.unwrap(guildA, wrapped))]).toEqual([...secret])
      expect([...(await (await reopen()).unwrap(guildA, wrapped))]).toEqual([...secret])
      expect([...(await provider.wrap(guildA, secret))]).not.toEqual([...wrapped])
    })

    test('unwrap rejects another guild and any tampering', async () => {
      const { provider } = await make()
      const wrapped = await provider.wrap(guildA, bytes('data key'))
      await expect(provider.unwrap(guildB, wrapped)).rejects.toThrow()
      const flipped = wrapped.slice()
      flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1
      await expect(provider.unwrap(guildA, flipped)).rejects.toThrow()
      await expect(provider.unwrap(guildA, new Uint8Array(3))).rejects.toThrow()
    })
  })
}
