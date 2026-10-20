import { describe, expect, test } from 'bun:test'
import type { CheckpointAnchor } from './checkpoint-anchor'

const cp = (seq: number, c = 'a') => ({
  seq,
  mac: c.repeat(64),
  signature: 'b'.repeat(64),
})

/** The CheckpointAnchor contract, run against every adapter. `make` returns a fresh anchor plus `reopen` over the same custody. */
export function checkpointAnchorContract(
  name: string,
  make: () => Promise<{ anchor: CheckpointAnchor; reopen: () => Promise<CheckpointAnchor> }>
) {
  describe(`CheckpointAnchor contract: ${name}`, () => {
    const guildA = crypto.randomUUID()
    const guildB = crypto.randomUUID()

    test('a guild with no checkpoint has none', async () => {
      const { anchor } = await make()
      expect(await anchor.latest(guildA)).toBeNull()
    })

    test('latest is the highest seq, also after reopening, whatever the publish order', async () => {
      const { anchor, reopen } = await make()
      await anchor.publish(guildA, cp(5))
      await anchor.publish(guildA, cp(9, 'c'))
      await anchor.publish(guildA, cp(7, 'd'))
      expect(await anchor.latest(guildA)).toEqual(cp(9, 'c'))
      expect(await (await reopen()).latest(guildA)).toEqual(cp(9, 'c'))
    })

    test('publishing the same checkpoint twice is harmless', async () => {
      const { anchor } = await make()
      await anchor.publish(guildA, cp(3))
      await anchor.publish(guildA, cp(3))
      expect(await anchor.latest(guildA)).toEqual(cp(3))
    })

    test('guilds are separate', async () => {
      const { anchor } = await make()
      await anchor.publish(guildA, cp(3))
      expect(await anchor.latest(guildB)).toBeNull()
    })

    test('concurrent publishes in one tick all land', async () => {
      const { anchor } = await make()
      await Promise.all([1, 2, 3, 4, 5, 6].map((n) => anchor.publish(guildA, cp(n))))
      expect((await anchor.latest(guildA))?.seq).toBe(6)
    })

    test('a guild id that could carry a path is refused', async () => {
      const { anchor } = await make()
      await expect(anchor.publish('../x', cp(1))).rejects.toThrow()
      await expect(anchor.latest('../x')).rejects.toThrow()
    })
  })
}
