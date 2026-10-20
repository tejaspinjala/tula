import { describe, expect, test } from 'bun:test'
import { createECDH, createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import { pushNotifierContract } from '../ports/push-notifier.contract'
import { FakePushService } from '../testing/fake-push-service'
import { WebPushNotifier } from './web-push-notifier'

const vapid = createECDH('prime256v1')
vapid.generateKeys()
const keys = {
  publicKey: vapid.getPublicKey().toString('base64url'),
  privateKey: vapid.getPrivateKey().toString('base64url'),
  subject: 'mailto:ops@guild.example',
}

function make(overrides: { timeoutMs?: number; retries?: number } = {}) {
  const service = new FakePushService()
  const sleeps: number[] = []
  const notifier = new WebPushNotifier({
    ...keys,
    fetch: service.fetch,
    sleep: async (ms) => {
      sleeps.push(ms)
    },
    random: () => 0.5,
    ...overrides,
  })
  return { service, notifier, sleeps }
}

const payload = () => ({ sealId: crypto.randomUUID(), guildId: crypto.randomUUID() })

pushNotifierContract('web push', async () => {
  const { service, notifier } = make()
  return {
    notifier,
    subscribe: (endpoint) => service.subscribe(endpoint),
    markGone: (endpoint) => service.drop(endpoint),
    delivered: async (endpoint) => service.delivered(endpoint),
  }
})

describe('WebPushNotifier', () => {
  test('signs a VAPID JWT for the push service origin with the configured key', async () => {
    const { service, notifier } = make()
    await notifier.send(service.subscribe('https://push.example/device/1'), payload())
    const auth = service.requests[0]?.headers.authorization ?? ''
    const match = /^vapid t=([\w-]+)\.([\w-]+)\.([\w-]+), k=([\w-]+)$/.exec(auth)
    expect(match?.[4]).toBe(keys.publicKey)
    const [, head = '', claims = '', signature = ''] = match ?? []
    const decoded = z
      .object({ aud: z.string(), sub: z.string(), exp: z.number() })
      .parse(JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')))
    expect(decoded.aud).toBe('https://push.example')
    expect(decoded.sub).toBe(keys.subject)
    expect(decoded.exp).toBeGreaterThan(Date.now() / 1000)
    expect(decoded.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600)
    const publicKey = createPublicKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        x: vapid.getPublicKey().subarray(1, 33).toString('base64url'),
        y: vapid.getPublicKey().subarray(33).toString('base64url'),
      },
      format: 'jwk',
    })
    expect(
      verify(
        'sha256',
        Buffer.from(`${head}.${claims}`),
        { key: publicKey, dsaEncoding: 'ieee-p1363' },
        Buffer.from(signature, 'base64url')
      )
    ).toBe(true)
  })

  test('a 404 or 410 from the push service means the subscription is gone', async () => {
    const { service, notifier } = make()
    const sub = service.subscribe('https://push.example/device/2')
    service.respondWith(404)
    expect(await notifier.send(sub, payload())).toBe('gone')
    service.respondWith(410)
    expect(await notifier.send(sub, payload())).toBe('gone')
  })

  test('a transient failure is retried with jittered backoff and then succeeds', async () => {
    const { service, notifier, sleeps } = make()
    const sub = service.subscribe('https://push.example/device/3')
    service.respondWith(503, 429)
    expect(await notifier.send(sub, payload())).toBe('sent')
    expect(service.requests).toHaveLength(3)
    expect(sleeps).toHaveLength(2)
    expect(sleeps[1]).toBeGreaterThan(sleeps[0] ?? 0)
  })

  test('retries are bounded: a push service that keeps failing makes send throw', async () => {
    const { service, notifier } = make({ retries: 2 })
    const sub = service.subscribe('https://push.example/device/4')
    service.respondWith(500, 500, 500, 500)
    await expect(notifier.send(sub, payload())).rejects.toThrow('push_unavailable')
    expect(service.requests).toHaveLength(3)
  })

  test('a request that never answers is abandoned at the timeout', async () => {
    const { service, notifier } = make({ timeoutMs: 20, retries: 0 })
    const sub = service.subscribe('https://push.example/device/5')
    service.respondWith('hang')
    await expect(notifier.send(sub, payload())).rejects.toThrow('push_unavailable')
  })

  test('a rejected request is not retried and the error carries no key material', async () => {
    const { service, notifier } = make()
    const sub = service.subscribe('https://push.example/device/6')
    service.respondWith(400)
    const error = await notifier.send(sub, payload()).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(Error)
    const text = error instanceof Error ? `${error.message} ${error.stack}` : ''
    expect(text).not.toContain(keys.privateKey)
    expect(text).not.toContain(sub.auth)
    expect(service.requests).toHaveLength(1)
  })
})
