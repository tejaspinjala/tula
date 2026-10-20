import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import { MemoryClock } from './adapters/memory-clock'
import { MemoryRateLimiter } from './adapters/memory-rate-limiter'
import { DEFAULT_RATE_LIMITS, RATE_ROUTE_AUTH, rateLimit } from './rate-limits'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const window = 60_000
const GUILD_LIMIT = 2
const tight = {
  client: { limit: 1000, windowMs: window },
  guild: { limit: GUILD_LIMIT, windowMs: window },
}
const harness = await createHarness({
  devGuildHeader: false,
  app: {
    rateLimiter: new MemoryRateLimiter(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
    rateLimits: {
      ...UNLIMITED_RATE_LIMITS,
      'learning-scan': tight,
      'proposal-post': tight,
      'events-history': tight,
      'signin-begin': tight,
    },
  },
})
afterAll(async () => {
  await harness.close()
})

/** Founds a guild and returns it with a signed-in session token. */
async function guildWithSession() {
  const guildId = await harness.foundGuild({ name: 'Rate', goal: 'g' })
  const key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
  const founding = await harness.adapters.identity.issueFoundingToken(guildId)
  const reg = await harness.adapters.identity.beginRegistration(guildId, {
    foundingToken: founding.token,
  })
  await harness.adapters.identity.finishRegistration(
    guildId,
    reg.challengeId,
    await key.register(reg.options)
  )
  const sign = await harness.adapters.identity.beginSignIn(guildId)
  const { token } = await harness.adapters.identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  return { guildId, token }
}

const sessionRoutes = [
  { name: 'learning scan', method: 'POST', path: (id: string) => `/guilds/${id}/learning/scan` },
  { name: 'proposals', method: 'POST', path: (id: string) => `/guilds/${id}/proposals` },
  { name: 'events history', method: 'GET', path: (id: string) => `/guilds/${id}/events/history` },
]

describe('session routes charge the per-guild bucket only after the session resolves to that guild', () => {
  for (const route of sessionRoutes) {
    test(`${route.name}: another guild's session or no session never exhausts the target guild`, async () => {
      const a = await guildWithSession()
      const b = await guildWithSession()
      const call = (token: string | undefined, id: string) =>
        harness.request(route.path(id), {
          method: route.method,
          headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          ...(route.method === 'POST' ? { body: '{}' } : {}),
        })
      for (let i = 0; i < GUILD_LIMIT * 3; i++) {
        expect((await call(b.token, a.guildId)).status).not.toBe(429)
        expect((await call(undefined, a.guildId)).status).not.toBe(429)
      }
      for (let i = 0; i < GUILD_LIMIT; i++) {
        expect((await call(a.token, a.guildId)).status).not.toBe(429)
      }
      expect((await call(a.token, a.guildId)).status).toBe(429)
    })
  }
})

describe('unauthenticated identity routes still limit per guild before auth', () => {
  test('sign-in begin answers 429 per guild without any session', async () => {
    const a = await guildWithSession()
    const begin = () =>
      harness.request(`/guilds/${a.guildId}/sign-in/begin`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    for (let i = 0; i < GUILD_LIMIT; i++) {
      expect((await begin()).status).not.toBe(429)
    }
    expect((await begin()).status).toBe(429)
  })
})

describe('session lookups', () => {
  test('a session route with no guild rule does zero session lookups', async () => {
    let lookups = 0
    const app = new Hono()
    app.post(
      '/guilds/:id/x',
      rateLimit(
        new MemoryRateLimiter(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
        'learning-scan',
        { client: { limit: 10, windowMs: window } },
        false,
        async () => {
          lookups += 1
          return null
        }
      ),
      (c) => c.json({ ok: true })
    )
    const res = await app.request('/guilds/0b0f6d0e-5f0a-4f0e-8a0e-0b0f6d0e5f0a/x', {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    expect(lookups).toBe(0)
  })
})

describe('every rate route is classified', () => {
  test('RATE_ROUTE_AUTH covers exactly the routes with limits, as session or unauthenticated', () => {
    expect(Object.keys(RATE_ROUTE_AUTH).sort()).toEqual(Object.keys(DEFAULT_RATE_LIMITS).sort())
    for (const auth of Object.values(RATE_ROUTE_AUTH)) {
      expect(['session', 'unauthenticated']).toContain(auth)
    }
  })

  test('identity routes are unauthenticated and guild-bucketed session routes are session', () => {
    const identity = [
      'signin-begin',
      'signin-finish',
      'passkeys-begin',
      'passkeys-finish',
      'founding',
      'reauth',
    ] as const
    for (const r of identity) {
      expect(RATE_ROUTE_AUTH[r]).toBe('unauthenticated')
    }
    const session = [
      'stream-ticket',
      'checkpoint-begin',
      'checkpoint-finish',
      'quest-post',
      'summon',
      'seal-posted',
      'proposal-post',
      'push-subscribe',
      'learning-scan',
      'events-history',
    ] as const
    for (const r of session) {
      expect(RATE_ROUTE_AUTH[r]).toBe('session')
    }
  })
})
