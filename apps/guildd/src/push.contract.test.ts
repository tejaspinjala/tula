import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const notifier = new MemoryPushNotifier()
const harness = await createHarness({
  devGuildHeader: false,
  app: { pushNotifier: notifier, vapidPublicKey: 'BPublicKeyForTests' },
})
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const keyBody = z.object({ publicKey: z.string() })

async function found(name: string) {
  const guild = await harness.foundGuild({ name, goal: 'g' })
  await harness.adapters.config.seed(guild)
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

const device = (endpoint: string) => ({
  endpoint,
  keys: { p256dh: 'p256dh-key', auth: 'auth-secret' },
})

function subscribe(guild: string, token: string | null, body: unknown, h = harness) {
  return h.request(`/guilds/${guild}/push/subscriptions`, {
    method: 'POST',
    headers: { ...json, ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
}

function unsubscribe(guild: string, token: string, endpoint: string) {
  return harness.request(`/guilds/${guild}/push/subscriptions`, {
    method: 'DELETE',
    headers: { ...json, authorization: `Bearer ${token}` },
    body: JSON.stringify({ endpoint }),
  })
}

describe('push routes', () => {
  test('a signed-in Guild Master subscribes a device and a Seal request then pushes it once', async () => {
    const { guild, token } = await found('Pushy')
    const res = await subscribe(guild, token, device('https://push.example/phone'))
    expect(res.status).toBe(201)
    const seal = await harness.adapters.seals.requestSeal(guild, {
      questId: crypto.randomUUID(),
      requestedBy: 'herald-1',
      kind: 'post',
      text: 'text that must not travel in a push',
      evidence: 'verdict: pass',
    })
    await harness.adapters.pushRelay.dispatch(guild)
    expect(notifier.sentTo('https://push.example/phone')).toEqual([
      { sealId: seal.id, guildId: guild },
    ])
  })

  test('the VAPID public key is served to a signed-in session', async () => {
    const { guild, token } = await found('Key')
    const res = await harness.request(`/guilds/${guild}/push/key`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(keyBody.parse(await res.json()).publicKey).toBe('BPublicKeyForTests')
    expect((await harness.request(`/guilds/${guild}/push/key`)).status).toBe(401)
  })

  test('subscribing needs a real session for that guild', async () => {
    const a = await found('A')
    const b = await found('B')
    expect((await subscribe(a.guild, null, device('https://push.example/x'))).status).toBe(401)
    expect((await subscribe(a.guild, b.token, device('https://push.example/x'))).status).toBe(404)
    expect((await harness.adapters.pushStore.list(a.guild, { limit: 10 })).subscriptions).toEqual(
      []
    )
  })

  test('a malformed subscription is a 400', async () => {
    const { guild, token } = await found('Bad')
    for (const body of [
      device('http://push.example/insecure'),
      { endpoint: 'https://push.example/x' },
      { endpoint: 'https://push.example/x', keys: { p256dh: '', auth: 'a' } },
      'nope',
    ]) {
      expect((await subscribe(guild, token, body)).status).toBe(400)
    }
  })

  test('unsubscribing removes the device and a second try is a 404', async () => {
    const { guild, token } = await found('Bye')
    await subscribe(guild, token, device('https://push.example/gone'))
    expect((await unsubscribe(guild, token, 'https://push.example/gone')).status).toBe(204)
    expect((await unsubscribe(guild, token, 'https://push.example/gone')).status).toBe(404)
  })

  test('subscribing is rate limited per client', async () => {
    const limited = await createHarness({
      devGuildHeader: false,
      app: {
        rateLimiter: new MemoryRateLimiter(new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))),
        rateLimits: { 'push-subscribe': { client: { limit: 2, windowMs: 60_000 } } },
      },
    })
    try {
      const guild = await limited.foundGuild({ name: 'Slow', goal: 'g' })
      const token = await openSession(limited.adapters.identity, guild)
      const statuses: number[] = []
      for (let i = 0; i < 3; i += 1) {
        statuses.push(
          (await subscribe(guild, token, device(`https://push.example/${i}`), limited)).status
        )
      }
      expect(statuses).toEqual([201, 201, 429])
    } finally {
      await limited.close()
    }
  })

  test('another guild cannot subscribe devices to, or read, a guild', async () => {
    // The probe founds its own guilds without a passkey, so the caller is a separate signed-in guild.
    const caller = await found('Caller')
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [
        `/guilds/${target}/push/subscriptions`,
        {
          method: 'POST',
          headers: { ...json, authorization: `Bearer ${caller.token}` },
          body: JSON.stringify(device('https://push.example/intruder')),
        },
      ],
      snapshot: async (guild) =>
        (await harness.adapters.pushStore.list(guild, { limit: 100 })).subscriptions,
    })
  })
})
