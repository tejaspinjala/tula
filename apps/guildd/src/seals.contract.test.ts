import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { eventsAfter } from './events'
import { hashProposal } from './ports/seal-store'
import { expectGuildIsolation } from './testing/cross-guild'
import { createHarness } from './testing/harness'
import { SoftwareAuthenticator } from './testing/software-authenticator'

const harness = await createHarness({ devGuildHeader: false })
const devHarness = await createHarness({ devGuildHeader: true })
afterAll(async () => {
  await harness.close()
  await devHarness.close()
})

const ORIGIN = 'http://localhost:5173'
const json = { 'content-type': 'application/json' }
const ceremony = z.object({ challengeId: z.string(), options: z.object({ challenge: z.string() }) })
const session = z.object({ token: z.string(), guildId: z.string() })
const foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const proofBody = z.object({ proof: z.string() })
const sealBody = z.object({
  id: z.string(),
  status: z.string(),
  text: z.string(),
  evidence: z.string(),
  actionHash: z.string(),
  decisionNote: z.string().nullable(),
})
const pageBody = z.object({ seals: z.array(sealBody), next: z.string().nullable() })

function send(h: typeof harness, method: string, path: string, body?: unknown, headers = {}) {
  return h.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}
const post = (path: string, body: unknown, headers = {}) =>
  send(harness, 'POST', path, body, headers)

async function signedIn() {
  const founded = foundedBody.parse(
    await (await post('/guilds', { name: 'Seals', goal: 'g' })).json()
  )
  const guildId = founded.id
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const reg = ceremony.parse(
    await (
      await post(
        `/guilds/${guildId}/passkeys/begin`,
        {},
        { 'x-founding-token': founded.foundingToken }
      )
    ).json()
  )
  await post(`/guilds/${guildId}/passkeys/finish`, {
    challengeId: reg.challengeId,
    response: await key.register(reg.options),
  })
  const begin = ceremony.parse(await (await post(`/guilds/${guildId}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const { token } = session.parse(await res.json())
  const auth = { authorization: `Bearer ${token}` }
  async function proof() {
    const b = ceremony.parse(await (await post('/session/reauth/begin', {}, auth)).json())
    const done = await post(
      '/session/reauth/finish',
      { challengeId: b.challengeId, response: await key.assert(b.options) },
      auth
    )
    return proofBody.parse(await done.json()).proof
  }
  async function request(text: string) {
    return harness.adapters.seals.requestSeal(guildId, {
      questId: crypto.randomUUID(),
      requestedBy: 'herald-1',
      kind: 'post',
      text,
      evidence: 'verdict: pass',
    })
  }
  async function act(sealId: string, verb: string, body: unknown, withProof = true) {
    const headers = withProof ? { ...auth, 'x-reauth-proof': await proof() } : auth
    return post(`/guilds/${guildId}/seals/${sealId}/${verb}`, body, headers)
  }
  return { guildId, auth, request, act }
}

describe('Seal inbox over HTTP', () => {
  test('the inbox shows the exact text, evidence and hash, paginated', async () => {
    const who = await signedIn()
    await who.request('first post')
    await who.request('second post')
    const res = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/seals?status=requested&limit=1`,
      undefined,
      who.auth
    )
    const page = pageBody.parse(await res.json())
    expect(page.seals).toHaveLength(1)
    expect(page.next).not.toBeNull()
    const [seal] = page.seals
    expect(seal?.evidence).toBe('verdict: pass')
    expect(seal?.actionHash).toBe(await hashProposal(seal?.text ?? ''))
  })

  test('stamping needs a fresh passkey re-authentication, and spends it', async () => {
    const who = await signedIn()
    const seal = await who.request('post me')
    const body = { actionHash: seal.actionHash }
    const without = await who.act(seal.id, 'approve', body, false)
    expect(without.status).toBe(403)
    expect(await without.json()).toEqual({ error: 'reauth_required' })
    const proof = await who.act(seal.id, 'approve', body)
    expect(proof.status).toBe(200)
    expect(sealBody.parse(await proof.json()).status).toBe('approved')
    // The proof was spent: replaying one on another action is refused.
    const again = await who.act(seal.id, 'approve', body, false)
    expect(again.status).toBe(403)
  })

  test('the dev header alone cannot stamp', async () => {
    const who = await signedIn()
    const seal = await who.request('post me')
    const res = await send(
      devHarness,
      'POST',
      `/guilds/${who.guildId}/seals/${seal.id}/approve`,
      { actionHash: seal.actionHash },
      { 'x-guild-id': who.guildId }
    )
    expect(res.status).toBe(401)
    expect((await harness.adapters.seals.get(who.guildId, seal.id))?.status).toBe('requested')
  })

  test('a hash that is not the Proposal hash decides nothing', async () => {
    const who = await signedIn()
    const seal = await who.request('post me')
    const res = await who.act(seal.id, 'approve', { actionHash: await hashProposal('other') })
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: 'hash_mismatch' })
  })

  test('denying keeps the note, and a denied Seal cannot then be approved', async () => {
    const who = await signedIn()
    const seal = await who.request('post me')
    const denied = await who.act(seal.id, 'deny', {
      actionHash: seal.actionHash,
      note: 'tone is off',
    })
    expect(sealBody.parse(await denied.json())).toMatchObject({
      status: 'denied',
      decisionNote: 'tone is off',
    })
    const late = await who.act(seal.id, 'approve', { actionHash: seal.actionHash })
    expect(late.status).toBe(409)
  })

  test('marking posted consumes the Seal and emits post.published_manually', async () => {
    const who = await signedIn()
    const seal = await who.request('post me')
    await who.act(seal.id, 'approve', { actionHash: seal.actionHash })
    const path = `/guilds/${who.guildId}/seals/${seal.id}/posted`
    const done = await post(path, { actionHash: seal.actionHash }, who.auth)
    expect(sealBody.parse(await done.json()).status).toBe('consumed')
    expect((await post(path, { actionHash: seal.actionHash }, who.auth)).status).toBe(409)
    const events = await harness.adapters.db.withGuild(who.guildId, (tx) => eventsAfter(tx, 0, 100))
    expect(events.map((e) => e.type)).toContain('post.published_manually')
    expect(JSON.stringify(events)).not.toContain('post me')
  })

  test('another guild cannot see or stamp a Seal', async () => {
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [`/guilds/${target}/seals`, { headers: { 'x-guild-id': caller } }],
      snapshot: async (guild) =>
        (await devHarness.adapters.seals.list(guild, { limit: 100 })).seals,
    })
  })
})
