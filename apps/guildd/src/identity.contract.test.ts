import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { REAUTH_TTL_MS } from './ports/identity'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })
const proofBody = z.object({ proof: z.string() })

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function foundWithPasskey() {
  const guildId = await harness.adapters.db.foundGuild({ name: 'Ember', goal: 'Ship' })
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const begin = ceremony.parse(await (await post(`/guilds/${guildId}/passkeys/begin`, {})).json())
  const finish = await post(`/guilds/${guildId}/passkeys/finish`, {
    challengeId: begin.challengeId,
    response: await key.register(begin.options),
  })
  expect(finish.status).toBe(201)
  return { guildId, key }
}

async function signIn(guildId: string, key: SoftwareAuthenticator) {
  const begin = ceremony.parse(await (await post(`/guilds/${guildId}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  expect(res.status).toBe(200)
  return session.parse(await res.json())
}

async function reauth(token: string, key: SoftwareAuthenticator) {
  const auth = { authorization: `Bearer ${token}` }
  const begin = ceremony.parse(await (await post('/session/reauth/begin', {}, auth)).json())
  const res = await post(
    '/session/reauth/finish',
    { challengeId: begin.challengeId, response: await key.assert(begin.options) },
    auth
  )
  expect(res.status).toBe(200)
  return proofBody.parse(await res.json()).proof
}

describe('passkey sign-in over HTTP', () => {
  test('a registered passkey signs in and the session reads its own guild', async () => {
    const { guildId, key } = await foundWithPasskey()
    const { token } = await signIn(guildId, key)
    const got = await harness.request(`/guilds/${guildId}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(got.status).toBe(200)
  })

  test('a session cannot act on another guild', async () => {
    const { guildId, key } = await foundWithPasskey()
    const { token } = await signIn(guildId, key)
    const other = await harness.adapters.db.foundGuild({ name: 'Other-secret', goal: 'g' })
    const res = await harness.request(`/guilds/${other}`, {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(404)
    expect(await res.text()).not.toContain('Other-secret')
  })

  test('cross-guild probe: a session of A aiming at B looks like a missing guild', async () => {
    const { guildId, key } = await foundWithPasskey()
    const { token } = await signIn(guildId, key)
    await expectGuildIsolation(harness, {
      build: (_caller, target) => [
        `/guilds/${target}/events`,
        { headers: { authorization: `Bearer ${token}` } },
      ],
      snapshot: async () => null,
    })
  })

  test('an unknown bearer token is unauthenticated', async () => {
    const { guildId } = await foundWithPasskey()
    const res = await harness.request(`/guilds/${guildId}`, {
      headers: { authorization: 'Bearer nope' },
    })
    expect(res.status).toBe(401)
  })
})

describe('sensitive actions', () => {
  async function addPasskey(token: string, guildId: string, proof?: string) {
    const headers: Record<string, string> = { authorization: `Bearer ${token}` }
    if (proof) {
      headers['x-reauth-proof'] = proof
    }
    return post(`/guilds/${guildId}/passkeys/begin`, {}, headers)
  }

  test('adding a second passkey needs a session and a fresh re-authentication proof', async () => {
    const { guildId, key } = await foundWithPasskey()
    expect((await post(`/guilds/${guildId}/passkeys/begin`, {})).status).toBe(401)
    const { token } = await signIn(guildId, key)
    const without = await addPasskey(token, guildId)
    expect(without.status).toBe(403)
    expect(await without.json()).toEqual({ error: 'reauth_required' })
    expect((await addPasskey(token, guildId, 'guess')).status).toBe(403)

    const proof = await reauth(token, key)
    expect((await addPasskey(token, guildId, proof)).status).toBe(200)

    harness.adapters.clock.advance(REAUTH_TTL_MS + 1)
    expect((await addPasskey(token, guildId, proof)).status).toBe(403)
  })
})
