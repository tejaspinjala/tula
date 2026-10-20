import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { MemoryPushStore } from './adapters/memory-push-store'
import { headSeq } from './events'
import { createSealPushRelay } from './seal-push'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

const founded = z.object({ id: z.string() })

/** Founds a guild through the public route, which also seeds its config. */
async function foundGuild(name: string): Promise<string> {
  const res = await harness.request('/guilds', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, goal: 'g' }),
  })
  return founded.parse(await res.json()).id
}

const MEMBER = '44444444-4444-4444-8444-444444444444'
const DEVICE = { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' }
const SECOND = { endpoint: 'https://push.example/tablet', p256dh: 'k', auth: 'a' }

async function setup(tuning: { maxAttempts?: number; retryMs?: number } = {}) {
  const store = new MemoryPushStore()
  const notifier = new MemoryPushNotifier()
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const relay = createSealPushRelay({
    db: harness.adapters.db,
    store,
    notifier,
    clock,
    leaseMs: 1000,
    ...tuning,
  })
  const guild = await foundGuild('Push')
  const request = (text: string, guildId = guild) =>
    harness.adapters.seals.requestSeal(guildId, {
      questId: crypto.randomUUID(),
      requestedBy: 'herald-1',
      kind: 'post',
      text,
      evidence: 'verdict: pass',
    })
  /** Subscribes a device the way the route does: from the guild's current event seq. */
  const subscribe = async (device = DEVICE) => {
    const since = await harness.adapters.db.withGuild(guild, headSeq)
    await store.add(guild, MEMBER, device, since)
  }
  return { store, notifier, clock, relay, guild, request, subscribe }
}

describe('Seal push relay', () => {
  test('a Seal request pushes each subscribed device exactly once, with ids only', async () => {
    const { notifier, relay, guild, request, subscribe } = await setup()
    await subscribe()
    const seal = await request('Secret launch copy: do not leak')
    await relay.dispatch(guild)
    await relay.dispatch(guild)
    await Promise.all([relay.dispatch(guild), relay.dispatch(guild)])
    expect(notifier.sends).toEqual([
      { endpoint: DEVICE.endpoint, payload: { sealId: seal.id, guildId: guild } },
    ])
    expect(JSON.stringify(notifier.sends)).not.toContain('Secret launch copy')
  })

  test('no push is sent for another guild: a device only hears about its own guild', async () => {
    const { notifier, relay, guild, request, subscribe } = await setup()
    const other = await foundGuild('Other')
    await subscribe()
    await request('other guild seal', other)
    await relay.dispatch(guild)
    await relay.dispatch(other)
    expect(notifier.sends).toEqual([])
  })

  test('Seals requested before a device subscribed are not pushed to it', async () => {
    const { notifier, relay, guild, request, subscribe } = await setup()
    await request('old seal')
    await subscribe()
    await relay.dispatch(guild)
    expect(notifier.sends).toEqual([])
    const fresh = await request('new seal')
    await relay.dispatch(guild)
    expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([fresh.id])
  })

  test('a subscription the push service has dropped is removed', async () => {
    const { store, notifier, relay, guild, request, subscribe } = await setup()
    await subscribe()
    notifier.markGone(DEVICE.endpoint)
    await request('seal')
    await relay.dispatch(guild)
    expect((await store.list(guild, { limit: 10 })).subscriptions).toEqual([])
  })

  test('a permanently unreachable device is dropped and never holds up the good one', async () => {
    const { store, notifier, relay, guild, request, subscribe } = await setup()
    await subscribe(DEVICE)
    await subscribe(SECOND)
    notifier.reject(DEVICE.endpoint)
    const first = await request('seal 1')
    await relay.dispatch(guild)
    const second = await request('seal 2')
    await relay.dispatch(guild)
    expect(notifier.sentTo(SECOND.endpoint).map((p) => p.sealId)).toEqual([first.id, second.id])
    expect((await store.list(guild, { limit: 10 })).subscriptions.map((s) => s.endpoint)).toEqual([
      SECOND.endpoint,
    ])
    expect(await store.cursor(guild)).toBe(await harness.adapters.db.withGuild(guild, headSeq))
  })

  test('two concurrent dispatches where the first send fails once deliver exactly once', async () => {
    const { notifier, relay, guild, request, subscribe } = await setup()
    await subscribe()
    const seal = await request('seal')
    notifier.failNext(1)
    const outcomes = await Promise.allSettled([relay.dispatch(guild), relay.dispatch(guild)])
    expect(outcomes.map((o) => o.status)).toContain('rejected')
    await relay.dispatch(guild)
    await relay.dispatch(guild)
    expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
  })

  test('a dispatch that cannot take the guild lease returns at once and sends nothing', async () => {
    const { store, notifier, clock, relay, guild, request, subscribe } = await setup()
    await subscribe()
    await request('seal')
    await store.acquireDispatchLease(guild, 'another-process', { now: clock.now(), leaseMs: 5000 })
    await relay.dispatch(guild)
    expect(notifier.sends).toEqual([])
    clock.advance(5001)
    await relay.dispatch(guild)
    expect(notifier.sends).toHaveLength(1)
  })

  test('a relay restart delivers a pending Seal with no new event', async () => {
    const { notifier, relay, guild, request, subscribe } = await setup()
    await subscribe()
    const seal = await request('seal')
    notifier.failNext(1)
    await expect(relay.dispatch(guild)).rejects.toThrow('delivery_pending')
    expect(notifier.sends).toEqual([])
    const running = await relay.start(() => undefined)
    try {
      for (let i = 0; i < 150 && notifier.sends.length === 0; i++) {
        await Bun.sleep(20)
      }
      expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
    } finally {
      await running.stop()
    }
  })

  test('many failing notifications leave one retry timer per guild', async () => {
    const { notifier, relay, request, subscribe } = await setup({ retryMs: 60_000 })
    await subscribe()
    const running = await relay.start(() => undefined)
    try {
      notifier.failNext(1000)
      for (let i = 0; i < 4; i++) {
        await request(`seal ${i}`)
        await Bun.sleep(40)
      }
      await Bun.sleep(150)
      expect(running.retryTimers()).toBe(1)
    } finally {
      await running.stop()
    }
  })

  test('a crash after the claim is retried once the lease expires', async () => {
    const { store, notifier, clock, relay, guild, request, subscribe } = await setup()
    await subscribe()
    const seal = await request('seal')
    // A sender claimed the delivery and died before sending.
    await store.claimDelivery(guild, seal.id, DEVICE.endpoint, {
      now: clock.now(),
      leaseMs: 1000,
      maxAttempts: 5,
    })
    await expect(relay.dispatch(guild)).rejects.toThrow('delivery_pending')
    expect(notifier.sends).toEqual([])
    clock.advance(1001)
    await relay.dispatch(guild)
    expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
  })

  test('a device that keeps failing is given up on after its attempts, and the event moves on', async () => {
    const { store, notifier, relay, guild, request, subscribe } = await setup({ maxAttempts: 2 })
    await subscribe()
    await request('seal')
    notifier.failNext(100)
    await expect(relay.dispatch(guild)).rejects.toThrow('delivery_pending')
    await expect(relay.dispatch(guild)).rejects.toThrow('delivery_pending')
    await relay.dispatch(guild)
    expect(await store.cursor(guild)).toBe(await harness.adapters.db.withGuild(guild, headSeq))
    expect(notifier.sends).toEqual([])
  })

  test('a live relay dispatches when the log grows and retries a failed send on its own', async () => {
    const { notifier, relay, request, subscribe } = await setup({ retryMs: 20 })
    await subscribe()
    const errors: unknown[] = []
    const running = await relay.start((e) => errors.push(e))
    try {
      notifier.failNext(1)
      const seal = await request('live seal')
      for (let i = 0; i < 150 && notifier.sends.length === 0; i++) {
        await Bun.sleep(20)
      }
      expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
      expect(errors.length).toBeGreaterThanOrEqual(1)
    } finally {
      await running.stop()
    }
  })
})
