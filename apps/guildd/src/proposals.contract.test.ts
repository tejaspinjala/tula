import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { hashProposal } from './ports/seal-store'
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
const verdictBody = z.object({
  proposalHash: z.string(),
  passed: z.boolean(),
  findings: z.array(z.object({ check: z.string(), passed: z.boolean() })),
})
const proposalBody = z.object({
  id: z.string(),
  hash: z.string(),
  content: z.string(),
  verdict: verdictBody,
})
const pageBody = z.object({ proposals: z.array(proposalBody), next: z.string().nullable() })

const send = (h: typeof harness, method: string, path: string, body?: unknown, headers = {}) =>
  h.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
const post = (path: string, body: unknown, headers = {}) =>
  send(harness, 'POST', path, body, headers)

async function signedIn() {
  const founded = await foundViaApi(harness, { name: 'Proposals', goal: 'g' })
  const guildId = founded.id
  const key = founded.key
  const begin = ceremony.parse(await (await post(`/guilds/${guildId}/sign-in/begin`, {})).json())
  const res = await post(`/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const { token } = session.parse(await res.json())
  const auth = { authorization: `Bearer ${token}` }
  const propose = (content: string, headers: Record<string, string> = auth) =>
    post(
      `/guilds/${guildId}/proposals`,
      { questId: crypto.randomUUID(), author: 'herald-1', kind: 'post', content },
      headers
    )
  return { guildId, auth, propose }
}

describe('Proposals and Verdicts over HTTP', () => {
  test('a Proposal is stored with a passing Verdict bound to its hash', async () => {
    const who = await signedIn()
    const res = await who.propose('Hello guild, see https://example.com/launch')
    expect(res.status).toBe(201)
    const p = proposalBody.parse(await res.json())
    expect(p.hash).toBe(await hashProposal(p.content))
    expect(p.verdict).toMatchObject({ proposalHash: p.hash, passed: true })
    const fetched = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/proposals/${p.id}`,
      undefined,
      who.auth
    )
    expect(proposalBody.parse(await fetched.json())).toEqual(p)
    const verdict = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/verdicts/${p.hash}`,
      undefined,
      who.auth
    )
    expect(verdictBody.parse(await verdict.json())).toEqual(p.verdict)
  })

  test('private data fails the Verdict, and the edited text is a new Proposal with its own Verdict', async () => {
    const who = await signedIn()
    const bad = proposalBody.parse(await (await who.propose('mail me at a@b.co')).json())
    expect(bad.verdict.passed).toBe(false)
    const fixed = proposalBody.parse(await (await who.propose('mail me soon')).json())
    expect(fixed.hash).not.toBe(bad.hash)
    expect(fixed.verdict.passed).toBe(true)
    const old = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/verdicts/${bad.hash}`,
      undefined,
      who.auth
    )
    expect(verdictBody.parse(await old.json()).passed).toBe(false)
    const unknown = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/verdicts/${await hashProposal('never proposed')}`,
      undefined,
      who.auth
    )
    expect(unknown.status).toBe(404)
  })

  test('writes need a real session, and lists are paginated', async () => {
    const who = await signedIn()
    expect((await who.propose('no session', {})).status).toBe(401)
    for (const t of ['one', 'two', 'three']) {
      await who.propose(t)
    }
    const res = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/proposals?limit=2`,
      undefined,
      who.auth
    )
    const page = pageBody.parse(await res.json())
    expect(page.proposals).toHaveLength(2)
    expect(page.next).not.toBeNull()
    const bad = await send(
      harness,
      'GET',
      `/guilds/${who.guildId}/proposals?limit=0`,
      undefined,
      who.auth
    )
    expect(bad.status).toBe(400)
  })

  test('the dev guild header never writes a Proposal', async () => {
    const who = await signedIn()
    const res = await send(
      devHarness,
      'POST',
      `/guilds/${who.guildId}/proposals`,
      {
        questId: crypto.randomUUID(),
        author: 'a',
        kind: 'post',
        content: 'x',
      },
      { 'x-guild-id': who.guildId }
    )
    expect(res.status).toBe(401)
  })

  test('another guild cannot see Proposals', async () => {
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [
        `/guilds/${target}/proposals`,
        { headers: { 'x-guild-id': caller } },
      ],
      snapshot: async (guild) =>
        (await devHarness.adapters.proposals.list(guild, { limit: 100 })).proposals,
    })
  })
})
