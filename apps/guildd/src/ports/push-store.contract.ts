import { describe, expect, test } from 'bun:test'
import type { DeliveryLease, PushStore } from './push-store'

/** A store under test. */
export interface PushStoreFixture {
  store: PushStore
  newGuild: () => Promise<string>
}

const MEMBER = '44444444-4444-4444-8444-444444444444'
const OTHER = '55555555-5555-4555-8555-555555555555'
const A = 'https://push.example/a'
const sub = (endpoint: string) => ({ endpoint, p256dh: 'p256dh-key', auth: 'auth-secret' })
const T0 = new Date('2030-01-01T00:00:00.000Z')
const lease = (offsetMs = 0, maxAttempts = 5): DeliveryLease => ({
  now: new Date(T0.getTime() + offsetMs),
  leaseMs: 1000,
  maxAttempts,
})

/** The PushStore contract, run against every adapter. */
export function pushStoreContract(name: string, make: () => Promise<PushStoreFixture>) {
  describe(`PushStore contract: ${name}`, () => {
    test('a subscription is listed with its owner and first-seen seq, replaced by its owner, and removed', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(await store.add(g, MEMBER, sub(A), 4)).toBe('added')
      expect(await store.add(g, MEMBER, { ...sub(A), auth: 'rotated' }, 9)).toBe('updated')
      const page = await store.list(g, { limit: 10 })
      expect(page.subscriptions).toEqual([
        { ...sub(A), auth: 'rotated', memberId: MEMBER, sinceSeq: 4 },
      ])
      expect(await store.remove(g, MEMBER, A)).toBe('removed')
      expect(await store.remove(g, MEMBER, A)).toBe('not_found')
      expect((await store.list(g, { limit: 10 })).subscriptions).toEqual([])
    })

    test("another member's endpoint can be neither replaced nor removed", async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      await store.add(g, MEMBER, sub(A), 1)
      expect(await store.add(g, OTHER, { ...sub(A), auth: 'hijack' }, 1)).toBe('conflict')
      expect(await store.remove(g, OTHER, A)).toBe('conflict')
      expect((await store.list(g, { limit: 10 })).subscriptions).toEqual([
        { ...sub(A), memberId: MEMBER, sinceSeq: 1 },
      ])
      expect(await store.drop(g, A)).toBe(true)
      expect(await store.drop(g, A)).toBe(false)
    })

    test('lists are paginated in endpoint order', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      for (const e of ['c', 'a', 'b']) {
        await store.add(g, MEMBER, sub(`https://push.example/${e}`), 0)
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

    test('a delivery is claimed once, even by many callers in the same tick, and then is done', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const seal = crypto.randomUUID()
      await store.add(g, MEMBER, sub(A), 0)
      const claims = await Promise.all(
        Array.from({ length: 8 }, () => store.claimDelivery(g, seal, A, lease()))
      )
      expect(claims.filter((c) => c === 'claimed')).toHaveLength(1)
      expect(claims.filter((c) => c === 'busy')).toHaveLength(7)
      await store.completeDelivery(g, seal, A)
      expect(await store.claimDelivery(g, seal, A, lease(10_000))).toBe('done')
    })

    test('a released claim is retried at once; a stale pending claim only after its lease expires', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const seal = crypto.randomUUID()
      await store.add(g, MEMBER, sub(A), 0)
      expect(await store.claimDelivery(g, seal, A, lease())).toBe('claimed')
      expect(await store.claimDelivery(g, seal, A, lease(999))).toBe('busy')
      expect(await store.claimDelivery(g, seal, A, lease(1001))).toBe('claimed')
      await store.releaseDelivery(g, seal, A, lease(1001).now)
      expect(await store.claimDelivery(g, seal, A, lease(1002))).toBe('claimed')
    })

    test('attempts are bounded: past the limit the delivery is failed for good', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      const seal = crypto.randomUUID()
      await store.add(g, MEMBER, sub(A), 0)
      expect(await store.claimDelivery(g, seal, A, lease(0, 2))).toBe('claimed')
      await store.releaseDelivery(g, seal, A, lease(0, 2).now)
      expect(await store.claimDelivery(g, seal, A, lease(1, 2))).toBe('claimed')
      await store.releaseDelivery(g, seal, A, lease(1, 2).now)
      expect(await store.claimDelivery(g, seal, A, lease(2, 2))).toBe('done')
      expect(await store.claimDelivery(g, seal, A, lease(99_999, 2))).toBe('done')
    })

    test('a delivery to a subscription that is gone is done', async () => {
      const { store, newGuild } = await make()
      const g = await newGuild()
      expect(
        await store.claimDelivery(g, crypto.randomUUID(), 'https://push.example/x', lease())
      ).toBe('done')
    })

    test('subscriptions, claims and cursors are scoped to their guild', async () => {
      const { store, newGuild } = await make()
      const [a, b] = [await newGuild(), await newGuild()]
      const seal = crypto.randomUUID()
      await store.add(a, MEMBER, sub(A), 0)
      expect((await store.list(b, { limit: 10 })).subscriptions).toEqual([])
      expect(await store.claimDelivery(b, seal, A, lease())).toBe('done')
      expect(await store.remove(b, MEMBER, A)).toBe('not_found')
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

    test("a guild's dispatch lease admits one holder, renews for it, and is taken over once expired", async () => {
      const { store, newGuild } = await make()
      const [g, other] = [await newGuild(), await newGuild()]
      const at = (offsetMs: number) => ({ now: new Date(T0.getTime() + offsetMs), leaseMs: 1000 })
      const taken = await Promise.all(
        ['a', 'b', 'c'].map((holder) => store.acquireDispatchLease(g, holder, at(0)))
      )
      expect(taken.filter(Boolean)).toHaveLength(1)
      const holder = ['a', 'b', 'c'][taken.indexOf(true)] ?? ''
      expect(await store.acquireDispatchLease(g, holder, at(500))).toBe(true)
      expect(await store.acquireDispatchLease(g, 'z', at(1499))).toBe(false)
      expect(await store.acquireDispatchLease(g, 'z', at(1501))).toBe(true)
      expect(await store.acquireDispatchLease(g, holder, at(1502))).toBe(false)
      await store.releaseDispatchLease(g, holder)
      expect(await store.acquireDispatchLease(g, 'z', at(1503))).toBe(true)
      await store.releaseDispatchLease(g, 'z')
      expect(await store.acquireDispatchLease(g, holder, at(1504))).toBe(true)
      expect(await store.acquireDispatchLease(other, 'y', at(0))).toBe(true)
    })

    test('guilds with devices are listed in id order, paginated', async () => {
      const { store, newGuild } = await make()
      const guilds = [await newGuild(), await newGuild(), await newGuild()]
      for (const g of guilds.slice(0, 2)) {
        await store.add(g, MEMBER, sub(A), 0)
      }
      const all: string[] = []
      let after: string | undefined
      for (;;) {
        const page = await store.guildsWithDevices(after, 1)
        const last = page.at(-1)
        if (!last) {
          break
        }
        all.push(...page)
        after = last
      }
      expect(all.filter((g) => guilds.includes(g))).toEqual(guilds.slice(0, 2).sort())
      expect(all).toEqual([...all].sort())
    })
  })
}
