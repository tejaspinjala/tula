import { afterAll, describe, expect, spyOn, test } from 'bun:test'
import { z } from 'zod'
import { eventsAfter } from './events'
import { expectGuildIsolation } from './testing/cross-guild'
import { foundViaApi } from './testing/found-via-api'
import { createHarness } from './testing/harness'

const harness = await createHarness({ devGuildHeader: false })
const devHarness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
  await devHarness.close()
})

const _ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })
const _foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const proofBody = z.object({ proof: z.string() })
const listBody = z.object({ refs: z.array(z.string()), next: z.string().nullable() })
const checkBody = z.object({
  results: z.array(z.object({ ref: z.string(), status: z.enum(['resolved', 'missing']) })),
})

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return harness.request(path, {
    method: 'POST',
    headers: { ...json, ...headers },
    body: JSON.stringify(body),
  })
}

async function signedIn() {
  const founded = await foundViaApi(harness, { name: 'Vault', goal: 'g' })
  const guildId = founded.id
  const key = founded.key
  const begin = ceremony.parse(await (await post(`/guilds/${guildId}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const { token } = session.parse(await res.json())
  const auth = { authorization: `Bearer ${token}` }
  return {
    guildId,
    auth,
    async proof() {
      const b = ceremony.parse(await (await post('/session/reauth/begin', {}, auth)).json())
      const done = await post(
        '/session/reauth/finish',
        { challengeId: b.challengeId, response: await key.assert(b.options) },
        auth
      )
      return proofBody.parse(await done.json()).proof
    },
  }
}

async function addSecret(
  who: Awaited<ReturnType<typeof signedIn>>,
  body: unknown,
  withProof = true
) {
  const headers: Record<string, string> = { ...who.auth }
  if (withProof) {
    headers['x-reauth-proof'] = await who.proof()
  }
  return post(`/guilds/${who.guildId}/vault/secrets`, body, headers)
}

describe('vault over HTTP', () => {
  test('adding a secret needs a session and a fresh re-authentication, spent by use', async () => {
    const who = await signedIn()
    const path = `/guilds/${who.guildId}/vault/secrets`
    const body = { ref: 'openai', value: 'sk-reauth-1' }
    expect((await post(path, body)).status).toBe(401)
    const without = await post(path, body, who.auth)
    expect(without.status).toBe(403)
    expect(await without.json()).toEqual({ error: 'reauth_required' })
    const proof = await who.proof()
    const ok = await post(path, body, { ...who.auth, 'x-reauth-proof': proof })
    expect(ok.status).toBe(201)
    expect(await ok.json()).toEqual({ ref: 'openai' })
    const replay = await post(
      path,
      { ref: 'other', value: 'sk-reauth-2' },
      { ...who.auth, 'x-reauth-proof': proof }
    )
    expect(replay.status).toBe(403)
    expect(await harness.adapters.secrets.resolve(who.guildId, 'openai')).toBe('sk-reauth-1')
  })

  test('authentication comes before the body: unauthenticated posts get 401 whatever they send', async () => {
    const who = await signedIn()
    const path = `/guilds/${who.guildId}/vault/secrets`
    const res = await post(path, { not: 'a secret' })
    expect(res.status).toBe(401)
  })

  test('a body over the cap is refused with 413 before it is read', async () => {
    const who = await signedIn()
    const path = `/guilds/${who.guildId}/vault/secrets`
    const big = JSON.stringify({ ref: 'openai', value: 'x'.repeat(20 * 1024) })
    const sized = { 'content-length': String(big.length) }
    const anon = await post(path, JSON.parse(big), sized)
    expect(anon.status).toBe(401)
    const headers = { ...who.auth, ...sized, 'x-reauth-proof': await who.proof() }
    const res = await post(path, JSON.parse(big), headers)
    expect(res.status).toBe(413)
    expect(await harness.adapters.secrets.check(who.guildId, ['openai'])).toEqual([
      { ref: 'openai', status: 'missing' },
    ])
  })

  test('a session cannot add a secret to another guild', async () => {
    const who = await signedIn()
    const other = await harness.foundGuild({ name: 'Other', goal: 'g' })
    const headers = { ...who.auth, 'x-reauth-proof': await who.proof() }
    const res = await post(`/guilds/${other}/vault/secrets`, { ref: 'openai', value: 'v' }, headers)
    expect(res.status).toBe(404)
    expect(await harness.adapters.secrets.check(other, ['openai'])).toEqual([
      { ref: 'openai', status: 'missing' },
    ])
  })

  test('list is paginated and check reports resolved or missing', async () => {
    const who = await signedIn()
    for (const ref of ['b', 'a', 'c']) {
      expect((await addSecret(who, { ref, value: `v-${ref}` })).status).toBe(201)
    }
    const base = `/guilds/${who.guildId}/vault/secrets`
    const page1 = listBody.parse(
      await (await harness.request(`${base}?limit=2`, { headers: who.auth })).json()
    )
    expect(page1).toEqual({ refs: ['a', 'b'], next: 'b' })
    const page2 = listBody.parse(
      await (await harness.request(`${base}?limit=2&after=b`, { headers: who.auth })).json()
    )
    expect(page2).toEqual({ refs: ['c'], next: null })
    const checked = checkBody.parse(
      await (
        await post(`/guilds/${who.guildId}/vault/check`, { refs: ['a', 'zzz'] }, who.auth)
      ).json()
    )
    expect(checked.results).toEqual([
      { ref: 'a', status: 'resolved' },
      { ref: 'zzz', status: 'missing' },
    ])
    expect((await harness.request(`${base}?limit=100000`, { headers: who.auth })).status).toBe(400)
  })

  test('no response, event or log line ever contains the secret value', async () => {
    const value = 'sk-NEVER-LEAK-9f8e7d6c'
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {})
    )
    try {
      const who = await signedIn()
      const bodies: string[] = []
      const record = async (res: Response) => {
        bodies.push(`${res.status} ${JSON.stringify([...res.headers])} ${await res.text()}`)
      }
      const base = `/guilds/${who.guildId}/vault`
      await record(await addSecret(who, { ref: 'openai', value }))
      await record(await addSecret(who, { ref: 'openai', value }))
      await record(await addSecret(who, { ref: 'BAD REF', value }))
      await record(await addSecret(who, { ref: 'noproof', value }, false))
      await record(await harness.request(`${base}/secrets`, { headers: who.auth }))
      await record(await post(`${base}/check`, { refs: ['openai'] }, who.auth))
      await record(await harness.request(`${base}/secrets/openai`, { headers: who.auth }))
      expect(bodies.join('\n')).not.toContain(value)
      const events = await harness.adapters.db.withGuild(who.guildId, (tx) =>
        eventsAfter(tx, 0, 1000)
      )
      expect(events.some((e) => e.type === 'vault.secret_added')).toBe(true)
      expect(JSON.stringify(events)).not.toContain(value)
      expect(JSON.stringify(spies.flatMap((s) => s.mock.calls))).not.toContain(value)
    } finally {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  })
})

describe('vault cross-guild', () => {
  test('cross-guild probe: listing and checking another guild look like a missing guild', async () => {
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/vault/secrets`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guildId) => devHarness.adapters.secrets.list(guildId, { limit: 100 }),
    })
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/vault/check`,
        {
          method: 'POST',
          headers: { ...json, 'x-guild-id': caller },
          body: JSON.stringify({ refs: ['openai'] }),
        },
      ],
      snapshot: async (guildId) => devHarness.adapters.secrets.check(guildId, ['openai']),
    })
  })
})
