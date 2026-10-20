import { afterAll, describe, expect, test } from 'bun:test'
import { createECDH, randomBytes } from 'node:crypto'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { openSession } from './testing/open-session'

const HOSTS = ['push.example']
const notifier = new MemoryPushNotifier()
const harness = await createHarness({
  devGuildHeader: false,
  app: { pushNotifier: notifier, vapidPublicKey: 'BPublicKeyForTests', pushAllowedHosts: HOSTS },
})
afterAll(() => harness.close())

const json = { 'content-type': 'application/json' }
const keyBody = z.object({ publicKey: z.string() })

async function found(name: string) {
  const guild = await harness.foundGuild({ name, goal: 'g' })
  await harness.adapters.config.seed(guild)
  return { guild, token: await openSession(harness.adapters.identity, guild) }
}

function realKeys() {
  const ecdh = createECDH('prime256v1')
  ecdh.generateKeys()
  return {
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  }
}

const device = (endpoint: string) => ({ endpoint, keys: realKeys() })

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

  test('an endpoint that is not a public push service is a 400 (SSRF)', async () => {
    const { guild, token } = await found('Ssrf')
    for (const endpoint of [
      'https://169.254.169.254/x',
      'https://127.0.0.1/',
      'https://localhost/',
      'https://[::1]/',
      'https://evil.example/',
      'http://push.example/x',
    ]) {
      expect((await subscribe(guild, token, device(endpoint))).status).toBe(400)
    }
    expect((await harness.adapters.pushStore.list(guild, { limit: 10 })).subscriptions).toEqual([])
  })

  test('device keys must be a P-256 point and a 16-byte auth secret', async () => {
    const { guild, token } = await found('Keys')
    const good = realKeys()
    for (const keys of [
      { p256dh: 'p256dh-key', auth: good.auth },
      { p256dh: good.p256dh, auth: 'auth-secret' },
      { p256dh: Buffer.alloc(65, 1).toString('base64url'), auth: good.auth },
    ]) {
      const res = await subscribe(guild, token, { endpoint: 'https://push.example/k', keys })
      expect(res.status).toBe(400)
    }
  })

  test('subscribing never waits on a push service, even a hung one', async () => {
    const hanging = await createHarness({
      devGuildHeader: false,
      app: {
        pushAllowedHosts: HOSTS,
        pushNotifier: { send: () => new Promise(() => undefined) },
      },
    })
    try {
      const guild = await hanging.foundGuild({ name: 'Hang', goal: 'g' })
      await hanging.adapters.config.seed(guild)
      const token = await openSession(hanging.adapters.identity, guild)
      await subscribe(guild, token, device('https://push.example/one'), hanging)
      await hanging.adapters.seals.requestSeal(guild, {
        questId: crypto.randomUUID(),
        requestedBy: 'herald-1',
        kind: 'post',
        text: 'seal',
        evidence: 'verdict: pass',
      })
      const outcome = await Promise.race([
        subscribe(guild, token, device('https://push.example/two'), hanging).then((r) => r.status),
        Bun.sleep(1000).then(() => 'timeout' as const),
      ])
      expect(outcome).toBe(201)
    } finally {
      await hanging.close()
    }
  })

  test("another member's endpoint is a 409 for both subscribe and unsubscribe", async () => {
    const { guild, token } = await found('Owner')
    const taken = device('https://push.example/taken')
    await harness.adapters.pushStore.add(
      guild,
      crypto.randomUUID(),
      { endpoint: taken.endpoint, ...taken.keys },
      0
    )
    expect((await subscribe(guild, token, taken)).status).toBe(409)
    expect((await unsubscribe(guild, token, taken.endpoint)).status).toBe(409)
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
        pushAllowedHosts: HOSTS,
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
