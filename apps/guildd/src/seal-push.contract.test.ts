import { afterAll, describe, expect, test } from 'bun:test'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { MemoryPushStore } from './adapters/memory-push-store'
import { createSealPushRelay } from './seal-push'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())

const DEVICE = { endpoint: 'https://push.example/phone', p256dh: 'k', auth: 'a' }

async function setup() {
  const store = new MemoryPushStore()
  const notifier = new MemoryPushNotifier()
  const relay = createSealPushRelay({ db: harness.adapters.db, store, notifier })
  const guild = await harness.foundGuild({ name: 'Push', goal: 'g' })
  const request = (text: string, guildId = guild) =>
    harness.adapters.seals.requestSeal(guildId, {
      questId: crypto.randomUUID(),
      requestedBy: 'herald-1',
      kind: 'post',
      text,
      evidence: 'verdict: pass',
    })
  return { store, notifier, relay, guild, request }
}

describe('Seal push relay', () => {
  test('a Seal request pushes each subscribed device exactly once, with ids only', async () => {
    const { store, notifier, relay, guild, request } = await setup()
    await store.add(guild, DEVICE)
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
    const { store, notifier, relay, guild, request } = await setup()
    const other = await harness.foundGuild({ name: 'Other', goal: 'g' })
    await store.add(guild, DEVICE)
    await request('other guild seal', other)
    await relay.dispatch(guild)
    await relay.dispatch(other)
    expect(notifier.sends).toEqual([])
  })

  test('Seals requested before a device subscribed are not pushed to it', async () => {
    const { store, notifier, relay, guild, request } = await setup()
    await request('old seal')
    await relay.dispatch(guild)
    await store.add(guild, DEVICE)
    await relay.dispatch(guild)
    expect(notifier.sends).toEqual([])
    const fresh = await request('new seal')
    await relay.dispatch(guild)
    expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([fresh.id])
  })

  test('a subscription the push service has dropped is removed', async () => {
    const { store, notifier, relay, guild, request } = await setup()
    await store.add(guild, DEVICE)
    notifier.markGone(DEVICE.endpoint)
    await request('seal')
    await relay.dispatch(guild)
    expect((await store.list(guild, { limit: 10 })).subscriptions).toEqual([])
  })

  test('a failed send is retried by the next dispatch and is not lost or doubled', async () => {
    const { store, notifier, relay, guild, request } = await setup()
    await store.add(guild, DEVICE)
    const seal = await request('seal')
    notifier.failNext(1)
    await expect(relay.dispatch(guild)).rejects.toThrow()
    await relay.dispatch(guild)
    await relay.dispatch(guild)
    expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
  })

  test('a live relay dispatches when the log grows', async () => {
    const { store, notifier, relay, guild, request } = await setup()
    await store.add(guild, DEVICE)
    const errors: unknown[] = []
    const running = await relay.start((e) => errors.push(e))
    try {
      const seal = await request('live seal')
      for (let i = 0; i < 100 && notifier.sends.length === 0; i++) {
        await Bun.sleep(20)
      }
      expect(notifier.sends.map((s) => s.payload.sealId)).toEqual([seal.id])
      expect(errors).toEqual([])
    } finally {
      await running.stop()
    }
  })
})
