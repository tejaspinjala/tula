import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { ENROL_TTL_MS } from './ports/identity'
import { expectGuildIsolation } from './testing/cross-guild'
import { foundViaApi } from './testing/found-via-api'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const _founded = z.object({ id: z.string(), foundingToken: z.string() })
const errorBody = z.object({ error: z.string() })

async function post(path: string, body: unknown, headers = {}, via = harness) {
  return via.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

/** A guild with one passkey, and a link token minted on the host. */
async function guildWithToken(via = harness) {
  const guild = await foundViaApi(via, { name: 'Ember', goal: 'Ship' })
  const _first = guild.key
  const { token } = await via.adapters.identity.issueEnrolmentToken(guild.id)
  return { guildId: guild.id, token }
}

async function enrolBegin(guildId: string, token: string, via = harness) {
  return post(`/guilds/${guildId}/enrol/begin`, {}, { 'x-enrol-token': token }, via)
}

describe('enrolling a passkey on a new device over HTTP', () => {
  test('begin and finish open a session for the guild and burn the token', async () => {
    const { guildId, token } = await guildWithToken()
    const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
    const begin = ceremony.parse(await (await enrolBegin(guildId, token)).json())
    const finish = await post(`/guilds/${guildId}/enrol/finish`, {
      challengeId: begin.challengeId,
      response: await key.register(begin.options),
    })
    expect(finish.status).toBe(201)
    const opened = z.object({ token: z.string(), guildId: z.string() }).parse(await finish.json())
    expect(opened.guildId).toBe(guildId)
    expect(opened.token).not.toContain(token)
    expect((await enrolBegin(guildId, token)).status).toBe(401)
  })

  test('a wrong token, an expired token and another guild token get the same refusal', async () => {
    const a = await guildWithToken()
    const b = await guildWithToken()
    const refusals: Array<{ status: number; body: unknown }> = []
    const attempts: Array<() => Promise<Response>> = [
      () => enrolBegin(a.guildId, 'guess'),
      () => enrolBegin(a.guildId, b.token),
      async () => {
        harness.adapters.clock.advance(ENROL_TTL_MS + 1)
        return enrolBegin(a.guildId, a.token)
      },
    ]
    for (const attempt of attempts) {
      const res = await attempt()
      refusals.push({ status: res.status, body: await res.json() })
    }
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1)
    expect(refusals[0]?.status).toBe(401)
    expect(errorBody.parse(refusals[0]?.body).error).toBe('registration_closed')
  })

  test('a missing token and an unknown guild are refused like a wrong token', async () => {
    const { guildId } = await guildWithToken()
    const missing = await post(`/guilds/${guildId}/enrol/begin`, {})
    const ghost = await enrolBegin(crypto.randomUUID(), 'guess')
    expect(missing.status).toBe(401)
    expect(ghost.status).toBe(401)
    expect(await missing.json()).toEqual(await ghost.json())
  })

  test('begin and finish are rate limited like sign-in', async () => {
    const tight = { client: { limit: 1, windowMs: 60_000 } }
    const limited = await createHarness({
      isolatedDb: true,
      devGuildHeader: false,
      app: {
        rateLimits: { ...UNLIMITED_RATE_LIMITS, 'enrol-begin': tight, 'enrol-finish': tight },
      },
    })
    try {
      const id = crypto.randomUUID()
      expect((await enrolBegin(id, 'x', limited)).status).toBe(401)
      const refused = await enrolBegin(id, 'x', limited)
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect((await post(`/guilds/${id}/enrol/finish`, {}, {}, limited)).status).toBe(400)
      expect((await post(`/guilds/${id}/enrol/finish`, {}, {}, limited)).status).toBe(429)
    } finally {
      await limited.close()
    }
  })

  test('a token of one guild aimed at another answers as it does for a guild that does not exist', async () => {
    await expectGuildIsolation(harness, {
      build: async (caller, target) => {
        const { token } = await harness.adapters.identity.issueEnrolmentToken(caller)
        return [
          `/guilds/${target}/enrol/begin`,
          { method: 'POST', headers: { ...json, 'x-enrol-token': token }, body: '{}' },
        ]
      },
      snapshot: (guildId) => harness.adapters.identity.hasCredentials(guildId),
    })
  })
})
