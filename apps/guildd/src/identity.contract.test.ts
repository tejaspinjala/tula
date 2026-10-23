import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { verifyChain } from './audit-chain'
import { eventsAfter } from './events'
import { REAUTH_TTL_MS } from './ports/identity'
import { expectGuildIsolation } from './testing/cross-guild'
import { foundViaApi } from './testing/found-via-api'
import { createHarness } from './testing/harness'
import type { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
afterAll(() => harness.close())

const _ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }

const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })
const _foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const proofBody = z.object({ proof: z.string() })

async function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function foundWithPasskey() {
  const founded = await foundViaApi(harness, { name: 'Ember', goal: 'Ship' })
  expect(founded.response.status).toBe(201)
  return { guildId: founded.id, key: founded.key }
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
    const other = await harness.foundGuild({ name: 'Other-secret', goal: 'g' })
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

  test('a re-authentication proof is spent by the sensitive action it authorised', async () => {
    const { guildId, key } = await foundWithPasskey()
    const { token } = await signIn(guildId, key)
    const proof = await reauth(token, key)
    expect((await addPasskey(token, guildId, proof)).status).toBe(200)
    const again = await addPasskey(token, guildId, proof)
    expect(again.status).toBe(403)
    expect(await again.json()).toEqual({ error: 'reauth_required' })
  })
})

describe('identity events in the audit chain', () => {
  test('a full founding, sign-in and re-auth flow leaves the chain intact, one entry per event', async () => {
    const { guildId, key } = await foundWithPasskey()
    const { token } = await signIn(guildId, key)
    await reauth(token, key)
    const { verdict, events } = await harness.adapters.db.withGuild(guildId, async (tx) => ({
      verdict: await verifyChain(tx, harness.adapters.keys, harness.adapters.witness),
      events: await eventsAfter(tx, 0),
    }))
    expect(events.map((e) => e.type)).toEqual([
      'guild.founded',
      'config.seeded',
      'identity.passkey_registered',
      'identity.signed_in',
      'identity.reauthenticated',
    ])
    expect(verdict).toMatchObject({ intact: true, entries: events.length })
  })
})
