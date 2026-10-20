import { describe, expect, test } from 'bun:test'
import type { PushStore } from './push-store'

/** A store under test. */
export interface PushStoreFixture {
  store: PushStore
  newGuild: () => Promise<string>
}

const sub = (endpoint: string) => ({ endpoint, p256dh: 'p256dh-key', auth: 'auth-secret' })

/** The PushStore contract, run against every adapter. */
export function pushStoreContract(name: string, make: () => Promise<PushStoreFixture>) {
  describe(`PushStore contract: ${name}`, () => {
    test('a subscription is listed, replaced on the same endpoint, and removed', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.add(g, sub('https://push.example/a'))
      await store.add(g, { ...sub('https://push.example/a'), auth: 'rotated' })
      const page = await store.list(g, { limit: 10 })
      expect(page.subscriptions).toEqual([{ ...sub('https://push.example/a'), auth: 'rotated' }])
      expect(await store.remove(g, 'https://push.example/a')).toBe(true)
      expect(await store.remove(g, 'https://push.example/a')).toBe(false)
      expect((await store.list(g, { limit: 10 })).subscriptions).toEqual([])
    })

    test('lists are paginated in endpoint order', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const e of ['c', 'a', 'b']) {
        await store.add(g, sub(`https://push.example/${e}`))
      }
      const first = await store.list(g, { limit: 2 })
      expect(first.subscriptions.map((s) => s.endpoint)).toEqual([
        'https://push.example/a',
        'https://push.example/b',
      ])
      expect(first.next).not.toBeNull()
      const rest = await store.list(g, { limit: 2, after: first.next ?? '' })
      expect(rest.subscriptions.map((s) => s.endpoint)).toEqual(['https://push.example/c'])
      expect(rest.next).toBeNull()
    })

    test('a delivery is claimed once, even by many callers in the same tick, until released', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const seal = crypto.randomUUID()
      await store.add(g, sub('https://push.example/a'))
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => store.claimDelivery(g, seal, 'https://push.example/a'))
      )
      expect(claims.filter(Boolean)).toHaveLength(1)
      await store.releaseDelivery(g, seal, 'https://push.example/a')
      expect(await store.claimDelivery(g, seal, 'https://push.example/a')).toBe(true)
    })

    test('a delivery cannot be claimed for a subscription that is gone', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.claimDelivery(g, crypto.randomUUID(), 'https://push.example/x')).toBe(
        false
      )
    })

    test('subscriptions, claims and cursors are scoped to their guild', async () => {
      const { store, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const seal = crypto.randomUUID()
      await store.add(a, sub('https://push.example/a'))
      expect((await store.list(b, { limit: 10 })).subscriptions).toEqual([])
      expect(await store.claimDelivery(b, seal, 'https://push.example/a')).toBe(false)
      expect(await store.remove(b, 'https://push.example/a')).toBe(false)
      await store.advanceCursor(a, 7)
      expect(await store.cursor(b)).toBe(0)
    })

    test('the cursor only moves forward', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.advanceCursor(g, 5)
      await store.advanceCursor(g, 3)
      expect(await store.cursor(g)).toBe(5)
    })
  })
}
