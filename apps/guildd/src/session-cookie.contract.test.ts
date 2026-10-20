import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DEFAULT_RATE_LIMITS } from './rate-limits'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
const tunnel = await createHarness({ devGuildHeader: false, app: { trustProxy: true } })
afterAll(async () => {
  await harness.close()
  await tunnel.close()
})

const ORIGIN = 'http://localhost:5173'
const COOKIE_MODE = { 'x-session-mode': 'cookie' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const founded = z.object({ id: z.string(), foundingToken: z.string() })
const tokenBody = z.object({ token: z.string() })

type Subject = typeof harness

function postJson(
  h: Subject,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  base = ''
) {
  return h.request(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

async function found(h: Subject) {
  const g = founded.parse(
    await (await postJson(h, '/guilds', { name: 'Ember', goal: 'Ship' })).json()
  )
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const begin = ceremony.parse(
    await (
      await postJson(
        h,
        `/guilds/${g.id}/passkeys/begin`,
        {},
        { 'x-founding-token': g.foundingToken }
      )
    ).json()
  )
  const done = await postJson(h, `/guilds/${g.id}/passkeys/finish`, {
    challengeId: begin.challengeId,
    response: await key.register(begin.options),
  })
  expect(done.status).toBe(201)
  return { guildId: g.id, key }
}

/** Signs in; `mode` adds the cookie-mode header. Returns the response and the cookie pair to replay. */
async function signIn(
  h: Subject,
  guildId: string,
  key: SoftwareAuthenticator,
  opts: { cookieMode?: boolean; base?: string; extra?: Record<string, string> } = {}
) {
  const base = opts.base ?? ''
  const extra = opts.extra ?? {}
  const begin = ceremony.parse(
    await (await postJson(h, `/guilds/${guildId}/sign-in/begin`, {}, extra, base)).json()
  )
  const res = await postJson(
    h,
    `/guilds/${guildId}/sign-in/finish`,
    { challengeId: begin.challengeId, response: await key.assert(begin.options) },
    { ...(opts.cookieMode === false ? {} : COOKIE_MODE), ...extra },
    base
  )
  const setCookie = res.headers.get('set-cookie') ?? ''
  return { res, setCookie, cookie: setCookie.split(';')[0] ?? '' }
}

async function bearerSignIn(guildId: string, key: SoftwareAuthenticator) {
  const { res } = await signIn(harness, guildId, key, { cookieMode: false })
  return tokenBody.parse(await res.json()).token
}

const same = { 'sec-fetch-site': 'same-origin' }

describe('session cookie', () => {
  test('sign-in sets an HttpOnly SameSite=Strict cookie, non-Secure only on localhost, and returns no token', async () => {
    const { guildId, key } = await found(harness)
    const { res, setCookie } = await signIn(harness, guildId, key)
    expect(res.status).toBe(200)
    const body = z
      .object({ guildId: z.string() })
      .passthrough()
      .parse(await res.json())
    expect(body.guildId).toBe(guildId)
    expect('token' in body).toBe(false)
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Strict')
    expect(setCookie).toContain('Path=/')
    expect(setCookie).toMatch(/Max-Age=\d+/)
    expect(setCookie).not.toContain('Secure')
  })

  test('behind the tunnel (https, TRUST_PROXY) and on any non-localhost host the cookie is Secure', async () => {
    const { guildId, key } = await found(tunnel)
    const viaProxy = await signIn(tunnel, guildId, key, { extra: { 'x-forwarded-proto': 'https' } })
    expect(viaProxy.setCookie).toContain('Secure')
    const remote = await signIn(tunnel, guildId, key, { base: 'http://guild.example.test' })
    expect(remote.setCookie).toContain('Secure')
  })

  test('a sign-in without the cookie mode still returns the bearer token and no cookie', async () => {
    const { guildId, key } = await found(harness)
    const { res } = await signIn(harness, guildId, key, { cookieMode: false })
    expect(tokenBody.parse(await res.json()).token).toBeTruthy()
    expect(res.headers.get('set-cookie')).toBeNull()
  })

  test('a reload keeps the session: the cookie alone reads the guild and who is signed in', async () => {
    const { guildId, key } = await found(harness)
    const { cookie } = await signIn(harness, guildId, key)
    const guild = await harness.request(`/guilds/${guildId}`, { headers: { cookie } })
    expect(guild.status).toBe(200)
    const me = await harness.request('/session', { headers: { cookie } })
    expect(await me.json()).toEqual({ guildId })
    expect((await harness.request('/session')).status).toBe(401)
  })

  test('a cross-site POST carrying the cookie is refused, a same-origin one is not', async () => {
    const { guildId, key } = await found(harness)
    const { cookie } = await signIn(harness, guildId, key)
    const ticket = (headers: Record<string, string>) =>
      postJson(harness, `/guilds/${guildId}/events/ticket`, {}, { cookie, ...headers })
    const cross = await ticket({ 'sec-fetch-site': 'cross-site' })
    expect(cross.status).toBe(403)
    expect(await cross.json()).toEqual({ error: 'csrf_refused' })
    expect((await ticket({ origin: 'https://evil.example' })).status).toBe(403)
    expect((await ticket(same)).status).toBe(200)
  })

  test('a bearer token needs no same-origin check', async () => {
    const { guildId, key } = await found(harness)
    const token = await bearerSignIn(guildId, key)
    const res = await postJson(
      harness,
      `/guilds/${guildId}/events/ticket`,
      {},
      { authorization: `Bearer ${token}`, 'sec-fetch-site': 'cross-site' }
    )
    expect(res.status).toBe(200)
  })

  test('sign-out clears the cookie and revokes the session: the old cookie and bearer both get 401', async () => {
    const { guildId, key } = await found(harness)
    const { cookie } = await signIn(harness, guildId, key)
    const out = await postJson(harness, '/session/logout', {}, { cookie, ...same })
    expect(out.status).toBe(204)
    expect(out.headers.get('set-cookie')).toMatch(/Max-Age=0/)
    expect((await harness.request(`/guilds/${guildId}`, { headers: { cookie } })).status).toBe(401)
    expect((await harness.request('/session', { headers: { cookie } })).status).toBe(401)

    const bearer = { authorization: `Bearer ${await bearerSignIn(guildId, key)}` }
    expect((await harness.request(`/guilds/${guildId}`, { headers: bearer })).status).toBe(200)
    expect((await postJson(harness, '/session/logout', {}, bearer)).status).toBe(204)
    expect((await harness.request(`/guilds/${guildId}`, { headers: bearer })).status).toBe(401)
  })

  test('a cross-site sign-out is refused and leaves the session alive', async () => {
    const { guildId, key } = await found(harness)
    const { cookie } = await signIn(harness, guildId, key)
    const out = await postJson(
      harness,
      '/session/logout',
      {},
      { cookie, 'sec-fetch-site': 'cross-site' }
    )
    expect(out.status).toBe(403)
    expect((await harness.request(`/guilds/${guildId}`, { headers: { cookie } })).status).toBe(200)
  })

  test('a cookie alone never satisfies re-authentication', async () => {
    const { guildId, key } = await found(harness)
    const { cookie } = await signIn(harness, guildId, key)
    const headers = { cookie, ...same }
    const add = (extra: Record<string, string> = {}) =>
      postJson(harness, `/guilds/${guildId}/passkeys/begin`, {}, { ...headers, ...extra })
    const without = await add()
    expect(without.status).toBe(403)
    expect(await without.json()).toEqual({ error: 'reauth_required' })

    const begin = ceremony.parse(
      await (await postJson(harness, '/session/reauth/begin', {}, headers)).json()
    )
    const done = await postJson(
      harness,
      '/session/reauth/finish',
      { challengeId: begin.challengeId, response: await key.assert(begin.options) },
      headers
    )
    expect(done.status).toBe(200)
    const { proof } = z.object({ proof: z.string() }).parse(await done.json())
    expect((await add({ 'x-reauth-proof': proof })).status).toBe(200)
  })
})

describe('session cookie review fixes', () => {
  test('cookie-authenticated requests keep the real socket address, not the shared unknown bucket', async () => {
    // Its own database: rate buckets are durable rows keyed by client address, so buckets left by
    // other files (or a rerun within the minute) on 127.0.0.1 would otherwise exhaust the budget.
    const limited = await createHarness({
      devGuildHeader: false,
      isolatedDb: true,
      app: { rateLimits: DEFAULT_RATE_LIMITS },
    })
    try {
      const base = limited.listen().replace('ws:', 'http:')
      const { guildId, key } = await found(limited)
      const { cookie } = await signIn(limited, guildId, key)
      // stream-ticket: the unknown bucket allows 10 a minute, the client bucket 30.
      const statuses: number[] = []
      for (let i = 0; i < 14; i++) {
        const res = await fetch(`${base}/guilds/${guildId}/events/ticket`, {
          method: 'POST',
          headers: { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
          body: '{}',
        })
        statuses.push(res.status)
      }
      expect(statuses.filter((s) => s === 429)).toEqual([])
      // Every request authenticated by the cookie, not merely un-throttled.
      expect(new Set(statuses)).toEqual(new Set([200]))
    } finally {
      await limited.close()
    }
  })

  test('Secure stays on whenever a proxy header is present, even without TRUST_PROXY', async () => {
    const { guildId, key } = await found(harness)
    for (const header of [
      { 'x-forwarded-proto': 'https' },
      { 'x-forwarded-host': 'guild.example.test' },
      { forwarded: 'proto=https' },
    ]) {
      const { setCookie } = await signIn(harness, guildId, key, {
        base: 'http://localhost:8787',
        extra: header,
      })
      expect(setCookie).toContain('Secure')
    }
  })

  test('a cross-site request cannot ask for a cookie session', async () => {
    const { guildId, key } = await found(harness)
    const { res, setCookie } = await signIn(harness, guildId, key, {
      extra: { 'sec-fetch-site': 'cross-site' },
    })
    expect(res.status).toBe(403)
    expect(setCookie).toBe('')
  })
})
