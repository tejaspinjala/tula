import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import type { RateLimits } from './rate-limits'
import { foundViaApi } from './testing/found-via-api'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'

const _ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const window = 60_000
const tight = (limit: number) => ({ limit, windowMs: window })

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })

const harnesses: Array<{ close: () => Promise<void> }> = []
afterAll(async () => {
  for (const h of harnesses) {
    await h.close()
  }
})

/** A harness whose limiter is isolated (memory, own clock) and whose limits are the given ones. */
async function harnessWith(rateLimits: Partial<RateLimits>, trustProxy = false) {
  const harness = await createHarness({
    devGuildHeader: false,
    app: {
      rateLimiter: new MemoryRateLimiter(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
      rateLimits: { ...UNLIMITED_RATE_LIMITS, ...rateLimits },
      trustProxy,
    },
  })
  harnesses.push(harness)
  const post = (
    path: string,
    headers: Record<string, string> = {},
    body: unknown = {},
    env?: unknown
  ) =>
    harness.request(
      path,
      { method: 'POST', headers: { ...json, ...headers }, body: JSON.stringify(body) },
      env
    )
  const found = async () => {
    const guild = await foundViaApi(harness, { name: 'Ember', goal: 'Ship' })
    expect(guild.response.status).toBe(201)
    return guild
  }
  return { harness, post, found }
}

/** Founds a guild through the atomic ceremony; its first passkey is `key`. */
async function withPasskey(
  _post: Awaited<ReturnType<typeof harnessWith>>['post'],
  found: Awaited<ReturnType<typeof harnessWith>>['found']
) {
  const { id, key } = await found()
  return { id, key }
}

describe('rate limits on unauthenticated identity routes', () => {
  test('sign-in begin answers 429 with Retry-After once a client exhausts its limit', async () => {
    const { post, found } = await harnessWith({ 'signin-begin': { client: tight(3) } })
    const { id } = await found()
    for (let i = 0; i < 3; i++) {
      expect((await post(`/guilds/${id}/sign-in/begin`)).status).toBe(200)
    }
    const refused = await post(`/guilds/${id}/sign-in/begin`)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect(await refused.json()).toEqual({ error: 'rate_limited' })
  })

  test('reauth begin answers 429 with Retry-After after N invalid-token calls from one address', async () => {
    const { post } = await harnessWith({ reauth: { client: tight(3) } })
    const bad = { authorization: 'Bearer not-a-session-token' }
    for (let i = 0; i < 3; i++) {
      expect((await post('/session/reauth/begin', bad)).status).not.toBe(429)
    }
    const refused = await post('/session/reauth/begin', bad)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    expect((await post('/session/reauth/finish', bad)).status).toBe(429)
  })

  test('passkeys begin and finish and founding are limited too', async () => {
    const { harness, post, found } = await harnessWith({
      'passkeys-begin': { client: tight(1) },
      'passkeys-finish': { client: tight(1) },
      founding: { client: tight(2) },
    })
    const { id } = await found()
    const begin = `/guilds/${id}/passkeys/begin`
    expect((await post(begin)).status).toBe(401)
    expect((await post(begin)).status).toBe(429)
    const finish = `/guilds/${id}/passkeys/finish`
    await post(finish)
    expect((await post(finish)).status).toBe(429)
    const second = await foundViaApi(harness, { name: 'Two', goal: 'Ship' })
    expect(second.response.status).toBe(201)
    const third = await foundViaApi(harness, { name: 'Three', goal: 'Ship' })
    expect(third.response.status).toBe(429)
    expect(third.response.headers.get('retry-after')).not.toBeNull()
  })

  test('the stream ticket route answers 429 with Retry-After past its client limit', async () => {
    const { post, found } = await harnessWith({ 'stream-ticket': { client: tight(2) } })
    const { id } = await found()
    const path = `/guilds/${id}/events/ticket`
    expect((await post(path)).status).toBe(401)
    expect((await post(path)).status).toBe(401)
    const refused = await post(path)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  test('checkpoint, Quest-posting and Seal-posted routes are limited too', async () => {
    const { post, found } = await harnessWith({
      'checkpoint-begin': { client: tight(2) },
      'checkpoint-finish': { client: tight(1) },
      'quest-post': { client: tight(1) },
      'seal-posted': { client: tight(1) },
    })
    const { id } = await found()
    const begin = `/guilds/${id}/audit/checkpoints/begin`
    expect((await post(begin)).status).toBe(401)
    expect((await post(begin)).status).toBe(401)
    const refused = await post(begin)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    for (const path of [
      `/guilds/${id}/audit/checkpoints/finish`,
      `/guilds/${id}/quests`,
      `/guilds/${id}/seals/${crypto.randomUUID()}/posted`,
    ]) {
      expect((await post(path)).status).not.toBe(429)
      expect((await post(path)).status).toBe(429)
    }
  })

  test('the summon route is limited per client, with a Retry-After', async () => {
    const { post, found } = await harnessWith({ summon: { client: tight(2) } })
    const { id } = await found()
    const path = `/guilds/${id}/summon`
    expect((await post(path)).status).toBe(401)
    expect((await post(path)).status).toBe(401)
    const refused = await post(path)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  test('the model gateway call route is limited per client', async () => {
    const { post } = await harnessWith({ 'gateway-call': { client: tight(1) } })
    expect((await post('/gateway/complete')).status).toBe(401)
    const refused = await post('/gateway/complete')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  test('X-Forwarded-For is ignored unless TRUST_PROXY is set', async () => {
    const { post, found } = await harnessWith({ 'signin-begin': { client: tight(2) } })
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/begin`
    await post(path, { 'x-forwarded-for': '1.1.1.1' })
    await post(path, { 'x-forwarded-for': '2.2.2.2' })
    expect((await post(path, { 'x-forwarded-for': '3.3.3.3' })).status).toBe(429)
  })

  test('behind a trusted proxy clients are keyed by the last forwarded hop', async () => {
    const { post, found } = await harnessWith({ 'signin-begin': { client: tight(1) } }, true)
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/begin`
    expect((await post(path, { 'x-forwarded-for': 'spoof-a, 9.9.9.1' })).status).toBe(200)
    expect((await post(path, { 'x-forwarded-for': 'spoof-b, 9.9.9.1' })).status).toBe(429)
    expect((await post(path, { 'x-forwarded-for': 'spoof-a, 9.9.9.2' })).status).toBe(200)
  })

  test('clients are told apart by their socket address', async () => {
    const { post, found } = await harnessWith({ 'signin-begin': { client: tight(1) } })
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/begin`
    const from = (address: string) => ({ requestIP: () => ({ address }) })
    expect((await post(path, {}, {}, from('10.0.0.1'))).status).toBe(200)
    expect((await post(path, {}, {}, from('10.0.0.1'))).status).toBe(429)
    expect((await post(path, {}, {}, from('10.0.0.2'))).status).toBe(200)
  })

  test('a blocked client does not spend the guild bucket, so one address cannot lock a guild', async () => {
    const { post, found } = await harnessWith({
      'signin-begin': { client: tight(30), guild: tight(120) },
    })
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/begin`
    const from = (address: string) => ({ requestIP: () => ({ address }) })
    const statuses: number[] = []
    for (let i = 0; i < 200; i++) {
      statuses.push((await post(path, {}, {}, from('10.0.0.1'))).status)
    }
    expect(statuses.filter((s) => s === 200)).toHaveLength(30)
    expect(statuses.filter((s) => s === 429)).toHaveLength(170)
    expect((await post(path, {}, {}, from('10.0.0.2'))).status).toBe(200)
  })

  test('sign-in finish is limited per client: the 31st call is refused with Retry-After', async () => {
    const { post, found } = await harnessWith({ 'signin-finish': { client: tight(30) } })
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/finish`
    for (let i = 0; i < 30; i++) {
      expect((await post(path)).status).toBe(400)
    }
    const refused = await post(path)
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  test('GET /founding is limited per client', async () => {
    const { harness } = await harnessWith({ 'founding-status': { client: tight(2) } })
    expect((await harness.request('/founding')).status).toBe(200)
    expect((await harness.request('/founding')).status).toBe(200)
    const refused = await harness.request('/founding')
    expect(refused.status).toBe(429)
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
  })

  test('callers with no known address share a stricter bucket', async () => {
    const { post, found } = await harnessWith({
      'signin-begin': { client: tight(5), unknown: tight(1) },
    })
    const { id } = await found()
    const path = `/guilds/${id}/sign-in/begin`
    expect((await post(path)).status).toBe(200)
    expect((await post(path)).status).toBe(429)
    const from = { requestIP: () => ({ address: '10.0.0.1' }) }
    expect((await post(path, {}, {}, from)).status).toBe(200)
    expect((await post(path, {}, {}, { requestIP: () => null })).status).toBe(429)
  })

  test('a guild limit holds across clients, and is per guild', async () => {
    const { post, found } = await harnessWith(
      { 'signin-begin': { client: tight(100), guild: tight(2) } },
      true
    )
    const a = (await found()).id
    const b = (await found()).id
    const hit = (guild: string, ip: string) =>
      post(`/guilds/${guild}/sign-in/begin`, { 'x-forwarded-for': ip })
    expect((await hit(a, '9.9.9.1')).status).toBe(200)
    expect((await hit(a, '9.9.9.2')).status).toBe(200)
    expect((await hit(a, '9.9.9.3')).status).toBe(429)
    expect((await hit(b, '9.9.9.3')).status).toBe(200)
  })
})

describe('sign-in begin does not reveal which guilds exist', () => {
  test('an unknown guild answers like a known one: same status and shape', async () => {
    const { post, found } = await harnessWith({})
    const { id: known } = await withPasskey(post, found)
    const real = await post(`/guilds/${known}/sign-in/begin`)
    const unknown = await post(`/guilds/${crypto.randomUUID()}/sign-in/begin`)
    const malformed = await post('/guilds/not-a-uuid/sign-in/begin')
    expect(unknown.status).toBe(real.status)
    expect(malformed.status).toBe(real.status)
    const shape = (body: unknown) => {
      const parsed = ceremony.extend({ options: z.looseObject({}) }).parse(body)
      return Object.keys(parsed.options).sort()
    }
    expect(shape(await unknown.json())).toEqual(shape(await real.json()))
  })

  test('sign-in finish for an unknown guild answers like a known guild with a bad challenge', async () => {
    const { post, found } = await harnessWith({})
    const known = (await found()).id
    const body = {
      challengeId: crypto.randomUUID(),
      response: {
        id: 'x',
        rawId: 'x',
        type: 'public-key',
        clientExtensionResults: {},
        response: {},
      },
    }
    const real = await post(`/guilds/${known}/sign-in/finish`, {}, body)
    const unknown = await post(`/guilds/${crypto.randomUUID()}/sign-in/finish`, {}, body)
    expect(unknown.status).toBe(real.status)
    expect(await unknown.json()).toEqual(await real.json())
  })
})

describe('a Guild Master mid re-authentication', () => {
  test('begins a reauth, then 25 sign-in begins from others, and the reauth still finishes', async () => {
    const { post, found } = await harnessWith({})
    const { id, key } = await withPasskey(post, found)
    const signInBegin = ceremony.parse(await (await post(`/guilds/${id}/sign-in/begin`)).json())
    const signedIn = session.parse(
      await (
        await post(
          `/guilds/${id}/sign-in/finish`,
          {},
          {
            challengeId: signInBegin.challengeId,
            response: await key.assert(signInBegin.options),
          }
        )
      ).json()
    )
    const auth = { authorization: `Bearer ${signedIn.token}` }
    const reauth = ceremony.parse(await (await post('/session/reauth/begin', auth)).json())
    const response = await key.assert(reauth.options)
    for (let i = 0; i < 25; i++) {
      expect((await post(`/guilds/${id}/sign-in/begin`)).status).toBe(200)
    }
    const finished = await post('/session/reauth/finish', auth, {
      challengeId: reauth.challengeId,
      response,
    })
    expect(finished.status).toBe(200)
  })
})
