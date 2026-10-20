import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { CHALLENGE_TTL_MS } from './ports/identity'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }

const ceremony = z.object({
  challengeId: z.string(),
  options: z.object({ challenge: z.string(), allowCredentials: z.array(z.unknown()).optional() }),
})
const session = z.object({ token: z.string(), guildId: z.string() })
const foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const errorBody = z.object({ error: z.string() })

async function post(path: string, body: unknown, via = harness, headers = {}) {
  return via.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function foundWithPasskey() {
  const founded = foundedBody.parse(
    await (await post('/guilds', { name: 'Ember', goal: 'Ship' })).json()
  )
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const begin = ceremony.parse(
    await (
      await post(`/guilds/${founded.id}/passkeys/begin`, {}, harness, {
        'x-founding-token': founded.foundingToken,
      })
    ).json()
  )
  const finish = await post(`/guilds/${founded.id}/passkeys/finish`, {
    challengeId: begin.challengeId,
    response: await key.register(begin.options),
  })
  expect(finish.status).toBe(201)
  return { guildId: founded.id, key }
}

async function beginUsernameless() {
  const res = await post('/sign-in/begin', {})
  expect(res.status).toBe(200)
  return ceremony.parse(await res.json())
}

describe('usernameless passkey sign-in over HTTP', () => {
  test('begin has no credential list; finish opens a session for the credential holder guild', async () => {
    const { guildId, key } = await foundWithPasskey()
    const begin = await beginUsernameless()
    expect(begin.options.allowCredentials ?? []).toEqual([])
    const res = await post('/sign-in/finish', {
      challengeId: begin.challengeId,
      response: await key.assert(begin.options),
    })
    expect(res.status).toBe(200)
    const opened = session.parse(await res.json())
    expect(opened.guildId).toBe(guildId)
    const got = await harness.request(`/guilds/${guildId}`, {
      headers: { authorization: `Bearer ${opened.token}` },
    })
    expect(got.status).toBe(200)
  })

  test('an unknown credential and a spent challenge are refused with the same body shape', async () => {
    const { key } = await foundWithPasskey()
    const stranger = await SoftwareAuthenticator.create('localhost', ORIGIN)
    const unknown = await beginUsernameless()
    const refusedUnknown = await post('/sign-in/finish', {
      challengeId: unknown.challengeId,
      response: await stranger.assert(unknown.options),
    })
    expect(refusedUnknown.status).toBe(401)
    expect(Object.keys(errorBody.parse(await refusedUnknown.json()))).toEqual(['error'])

    const spent = await beginUsernameless()
    const response = await key.assert(spent.options)
    expect(
      (await post('/sign-in/finish', { challengeId: spent.challengeId, response })).status
    ).toBe(200)
    const replay = await post('/sign-in/finish', { challengeId: spent.challengeId, response })
    expect(replay.status).toBe(400)
    expect(errorBody.parse(await replay.json()).error).toBe('invalid_challenge')
  })

  test('an expired challenge is refused', async () => {
    const { key } = await foundWithPasskey()
    const begin = await beginUsernameless()
    harness.adapters.clock.advance(CHALLENGE_TTL_MS + 1)
    const res = await post('/sign-in/finish', {
      challengeId: begin.challengeId,
      response: await key.assert(begin.options),
    })
    expect(res.status).toBe(400)
    expect(errorBody.parse(await res.json()).error).toBe('invalid_challenge')
  })

  test('a malformed finish body is a 400', async () => {
    const res = await post('/sign-in/finish', { challengeId: 'x' })
    expect(res.status).toBe(400)
  })

  test('begin and finish are rate limited like the per-guild sign-in routes', async () => {
    const tight = { client: { limit: 1, windowMs: 60_000 } }
    const limited = await createHarness({
      devGuildHeader: false,
      app: {
        rateLimits: {
          ...UNLIMITED_RATE_LIMITS,
          'signin-begin': tight,
          'signin-finish': tight,
        },
      },
    })
    try {
      expect((await post('/sign-in/begin', {}, limited)).status).toBe(200)
      const refused = await post('/sign-in/begin', {}, limited)
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect((await post('/sign-in/finish', {}, limited)).status).toBe(400)
      expect((await post('/sign-in/finish', {}, limited)).status).toBe(429)
    } finally {
      await limited.close()
    }
  })
})
