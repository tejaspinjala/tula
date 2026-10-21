import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { DESKTOP_CODE_TTL_MS } from './ports/identity'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const founded = z.object({ id: z.string(), foundingToken: z.string() })
const opened = z.object({ token: z.string(), guildId: z.string() })
const handoff = z.object({ code: z.string(), expiresAt: z.string() })
const errorBody = z.object({ error: z.string() })

async function post(path: string, body: unknown, headers = {}, via = harness) {
  return via.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

/** A founded guild whose Guild Master has signed in: its id and a Bearer session token. */
async function signedInGuild(via = harness) {
  const guild = founded.parse(
    await (await post('/guilds', { name: 'Ember', goal: 'Ship' }, {}, via)).json()
  )
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const reg = ceremony.parse(
    await (
      await post(
        `/guilds/${guild.id}/passkeys/begin`,
        {},
        { 'x-founding-token': guild.foundingToken },
        via
      )
    ).json()
  )
  await post(
    `/guilds/${guild.id}/passkeys/finish`,
    { challengeId: reg.challengeId, response: await key.register(reg.options) },
    {},
    via
  )
  const sign = ceremony.parse(
    await (await post(`/guilds/${guild.id}/sign-in/begin`, {}, {}, via)).json()
  )
  const session = opened.parse(
    await (
      await post(
        `/guilds/${guild.id}/sign-in/finish`,
        { challengeId: sign.challengeId, response: await key.assert(sign.options) },
        {},
        via
      )
    ).json()
  )
  return { guildId: guild.id, token: session.token }
}

const STATE = 's'.repeat(22)

function begin(token: string | null, via = harness, state: string | null = STATE) {
  return post(
    '/auth/desktop/begin',
    state === null ? {} : { state },
    token ? { authorization: `Bearer ${token}` } : {},
    via
  )
}

function exchange(code: string, headers = {}, via = harness, state: string | null = STATE) {
  return post('/auth/desktop/exchange', state === null ? { code } : { code, state }, headers, via)
}

describe('handing a browser sign-in to the desktop shell over HTTP', () => {
  test('a signed-in session mints a code; exchanging it yields a Bearer session once', async () => {
    const { guildId, token } = await signedInGuild()
    const minted = await begin(token)
    expect(minted.status).toBe(201)
    const { code } = handoff.parse(await minted.json())
    const res = await exchange(code)
    expect(res.status).toBe(201)
    const session = opened.parse(await res.json())
    expect(session.guildId).toBe(guildId)
    expect(session.token).not.toBe(token)
    const who = await harness.request('/session', {
      headers: { authorization: `Bearer ${session.token}` },
    })
    expect(who.status).toBe(200)
    expect((await exchange(code)).status).toBe(400)
  })

  test('the exchange can ask for a cookie session and then never returns the token in the body', async () => {
    const { token } = await signedInGuild()
    const { code } = handoff.parse(await (await begin(token)).json())
    const res = await exchange(code, { 'x-session-mode': 'cookie', origin: 'http://localhost' })
    expect(res.status).toBe(201)
    expect(res.headers.get('set-cookie') ?? '').toContain('HttpOnly')
    expect(JSON.stringify(await res.json())).not.toContain('token')
  })

  test('a missing or wrong state is refused like a wrong code, and a begin without a state is a 400', async () => {
    const { token } = await signedInGuild()
    const { code } = handoff.parse(await (await begin(token)).json())
    const wrong = await exchange(code, {}, harness, 'x'.repeat(22))
    const missing = await exchange(code, {}, harness, null)
    expect(wrong.status).toBe(400)
    expect(errorBody.parse(await wrong.json()).error).toBe('invalid_challenge')
    expect(missing.status).toBe(400)
    expect(errorBody.parse(await missing.json()).error).toBe('invalid_challenge')
    expect((await begin(token, harness, null)).status).toBe(400)
    expect((await exchange(code)).status).toBe(201)
  })

  test('minting without a session is refused', async () => {
    expect((await begin(null)).status).toBe(401)
    expect((await begin('nope')).status).toBe(401)
  })

  test('an expired, wrong and unknown-guild code get the same refusal; a body without a code is a 400', async () => {
    const { token } = await signedInGuild()
    const { code } = handoff.parse(await (await begin(token)).json())
    harness.adapters.clock.advance(DESKTOP_CODE_TTL_MS + 1)
    const refusals: Array<{ status: number; body: unknown }> = []
    for (const attempt of [
      exchange(code),
      exchange('guess'),
      exchange(`${crypto.randomUUID()}.x`),
    ]) {
      const res = await attempt
      refusals.push({ status: res.status, body: await res.json() })
    }
    expect((await post('/auth/desktop/exchange', {})).status).toBe(400)
    expect(new Set(refusals.map((r) => JSON.stringify(r))).size).toBe(1)
    expect(errorBody.parse(refusals[0]?.body).error).toBe('invalid_challenge')
  })

  test('begin and exchange are rate limited', async () => {
    const tight = { client: { limit: 1, windowMs: 60_000 } }
    const limited = await createHarness({
      isolatedDb: true,
      devGuildHeader: false,
      app: {
        rateLimits: {
          ...UNLIMITED_RATE_LIMITS,
          'desktop-begin': tight,
          'desktop-exchange': tight,
        },
      },
    })
    try {
      expect((await begin(null, limited)).status).toBe(401)
      const refused = await begin(null, limited)
      expect(refused.status).toBe(429)
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
      expect((await exchange('x', {}, limited)).status).toBe(400)
      expect((await exchange('x', {}, limited)).status).toBe(429)
    } finally {
      await limited.close()
    }
  })

  test("one guild's code aimed at another guild answers as for a guild that does not exist", async () => {
    const a = await signedInGuild()
    const b = await signedInGuild()
    const { code } = handoff.parse(await (await begin(a.token)).json())
    const atB = await exchange(code.replace(a.guildId, b.guildId))
    const atGhost = await exchange(code.replace(a.guildId, crypto.randomUUID()))
    expect(atB.status).toBe(400)
    expect(await atB.json()).toEqual(await atGhost.json())
    // The code still works for its own guild: the misdirected attempt spent nothing of A's.
    expect(opened.parse(await (await exchange(code)).json()).guildId).toBe(a.guildId)
  })
})
