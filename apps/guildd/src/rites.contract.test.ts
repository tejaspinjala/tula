import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { RITE_EVENT_PREFIX } from './rites/events'
import type { RiteGraph } from './rites/graph'
import { LEARNING_TO_LINKEDIN } from './rites/templates'
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
const foundedBody = z.object({ id: z.string(), foundingToken: z.string() })
const tokenBody = z.object({ token: z.string() })
const proofBody = z.object({ proof: z.string() })
const listBody = z.object({
  rites: z.array(
    z.object({ id: z.string(), latestVersion: z.number(), activeVersion: z.number().nullable() })
  ),
  next: z.string().nullable(),
})
const saved = z.object({
  status: z.enum(['active', 'pending']),
  version: z.object({ version: z.number(), classification: z.string() }),
})
const invalid = z.object({
  error: z.literal('invalid_rite'),
  errors: z.array(z.object({ code: z.string(), nodeId: z.string().optional() })),
})
const runBody = z.object({
  instance: z.object({ id: z.string(), version: z.number() }),
  quests: z.array(z.object({ nodeId: z.string(), questId: z.string() })),
})
const stateBody = z.object({
  nodes: z.array(z.object({ id: z.string(), status: z.string() })),
})

function send(method: string, path: string, body?: unknown, headers = {}, h = harness) {
  return h.request(path, {
    method,
    headers: { ...json, ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function signedIn() {
  const founded = foundedBody.parse(
    await (await send('POST', '/guilds', { name: 'Flows', goal: 'g' })).json()
  )
  const guildId = founded.id
  const key = await SoftwareAuthenticator.create('localhost', ORIGIN)
  const reg = ceremony.parse(
    await (
      await send(
        'POST',
        `/guilds/${guildId}/passkeys/begin`,
        {},
        { 'x-founding-token': founded.foundingToken }
      )
    ).json()
  )
  await send('POST', `/guilds/${guildId}/passkeys/finish`, {
    challengeId: reg.challengeId,
    response: await key.register(reg.options),
  })
  const begin = ceremony.parse(
    await (await send('POST', `/guilds/${guildId}/sign-in/begin`, {})).json()
  )
  const res = await send('POST', `/guilds/${guildId}/sign-in/finish`, {
    challengeId: begin.challengeId,
    response: await key.assert(begin.options),
  })
  const auth = { authorization: `Bearer ${tokenBody.parse(await res.json()).token}` }
  return {
    guildId,
    auth,
    base: `/guilds/${guildId}/rites`,
    async proof() {
      const b = ceremony.parse(await (await send('POST', '/session/reauth/begin', {}, auth)).json())
      const done = await send(
        'POST',
        '/session/reauth/finish',
        { challengeId: b.challengeId, response: await key.assert(b.options) },
        auth
      )
      return proofBody.parse(await done.json()).proof
    },
  }
}

const graph = (): RiteGraph => structuredClone(LEARNING_TO_LINKEDIN)

describe('rite routes', () => {
  test('Rites are served under /rites and the old /rites path is gone', async () => {
    const who = await signedIn()
    expect((await send('GET', `/guilds/${who.guildId}/rites`, undefined, who.auth)).status).toBe(
      200
    )
    // ADR-0013 retired the old path with no alias; its spelling survives only in the event prefix.
    const retired = `/guilds/${who.guildId}/${RITE_EVENT_PREFIX.slice(0, -1)}s`
    expect((await send('GET', retired, undefined, who.auth)).status).toBe(404)
  })

  test('every route needs a real session: none, and the dev header, are refused', async () => {
    const who = await signedIn()
    expect((await send('GET', who.base)).status).toBe(401)
    expect(
      (await send('GET', who.base, undefined, { 'x-guild-id': who.guildId }, devHarness)).status
    ).toBe(401)
    expect((await send('PUT', `${who.base}/x`, { name: 'x', graph: graph() })).status).toBe(401)
    expect((await send('POST', `${who.base}/x/runs`, {})).status).toBe(401)
  })

  test('the list seeds the Learning to LinkedIn template once and pages in id order', async () => {
    const who = await signedIn()
    const first = listBody.parse(await (await send('GET', who.base, undefined, who.auth)).json())
    expect(first.rites).toMatchObject([
      {
        id: 'learning-to-linkedin',
        latestVersion: 1,
        activeVersion: 1,
      },
    ])
    const again = listBody.parse(await (await send('GET', who.base, undefined, who.auth)).json())
    expect(again.rites).toHaveLength(1)
    expect((await send('GET', `${who.base}?limit=0`, undefined, who.auth)).status).toBe(400)
  })

  test('validate is a dry run: coded errors per node, nothing stored', async () => {
    const who = await signedIn()
    const bad = graph()
    bad.edges = bad.edges.filter((e) => e.to !== 'seal')
    bad.edges.push({ from: 'check', to: 'publish' })
    const res = await send('POST', `${who.base}/dry/validate`, { graph: bad }, who.auth)
    expect(res.status).toBe(200)
    const body = z
      .object({ valid: z.boolean(), errors: z.array(z.object({ code: z.string() })) })
      .parse(await res.json())
    expect(body.valid).toBe(false)
    expect(body.errors.map((e) => e.code)).toContain('gate_unapproved')
    expect((await send('GET', `${who.base}/dry`, undefined, who.auth)).status).toBe(404)
    const ok = await send('POST', `${who.base}/dry/validate`, { graph: graph() }, who.auth)
    expect(await ok.json()).toMatchObject({ valid: true, errors: [] })
  })

  test('a save is refused with coded errors, or stored pending until a fresh re-authentication confirms it', async () => {
    const who = await signedIn()
    const bad = graph()
    bad.edges = bad.edges.filter((e) => e.to !== 'seal')
    bad.edges.push({ from: 'check', to: 'publish' })
    const refused = await send('PUT', `${who.base}/mine`, { name: 'Mine', graph: bad }, who.auth)
    expect(refused.status).toBe(422)
    expect(invalid.parse(await refused.json()).errors.map((e) => e.code)).toContain(
      'gate_unapproved'
    )

    const first = await send('PUT', `${who.base}/mine`, { name: 'Mine', graph: graph() }, who.auth)
    expect(first.status).toBe(202)
    expect(saved.parse(await first.json())).toMatchObject({
      status: 'pending',
      version: { version: 1, classification: 'widening' },
    })
    const run = await send('POST', `${who.base}/mine/runs`, {}, who.auth)
    expect(run.status).toBe(409)

    const confirm = `${who.base}/mine/versions/1/confirm`
    expect((await send('POST', confirm, {}, who.auth)).status).toBe(403)
    const ok = await send('POST', confirm, {}, { ...who.auth, 'x-reauth-proof': await who.proof() })
    expect(ok.status).toBe(200)

    const edited = graph()
    const draft = edited.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') {
      throw new Error('template changed')
    }
    draft.briefTemplate = 'A calmer brief'
    const second = await send('PUT', `${who.base}/mine`, { name: 'Mine', graph: edited }, who.auth)
    expect(second.status).toBe(200)
    expect(saved.parse(await second.json())).toMatchObject({
      status: 'active',
      version: { version: 2, classification: 'internal' },
    })

    const versions = z
      .object({
        versions: z.array(z.object({ version: z.number() })),
        next: z.number().nullable(),
      })
      .parse(
        await (await send('GET', `${who.base}/mine/versions?limit=1`, undefined, who.auth)).json()
      )
    expect(versions.versions.map((v) => v.version)).toEqual([2])
    expect(versions.next).toBe(2)
    const one = await send('GET', `${who.base}/mine`, undefined, who.auth)
    expect(await one.json()).toMatchObject({ version: { version: 2 }, activeVersion: 2 })
  })

  test('a confirm checks the guild and the version before it spends the re-authentication proof', async () => {
    const who = await signedIn()
    const other = await signedIn()
    await send('PUT', `${who.base}/mine`, { name: 'Mine', graph: graph() }, who.auth)
    const headers = { ...who.auth, 'x-reauth-proof': await who.proof() }
    const confirm = `${who.base}/mine/versions/1/confirm`
    const foreign = `/guilds/${other.guildId}/rites/mine/versions/1/confirm`
    expect((await send('POST', foreign, {}, headers)).status).toBe(404)
    expect((await send('POST', `${who.base}/mine/versions/9/confirm`, {}, headers)).status).toBe(
      404
    )
    expect((await send('POST', confirm, {}, headers)).status).toBe(200)
    const spare = { ...who.auth, 'x-reauth-proof': await who.proof() }
    expect((await send('POST', confirm, {}, spare)).status).toBe(409)
    expect((await send('POST', confirm, {}, spare)).status).toBe(409)
  })

  test('a run creates an instance pinned to a version; its Quests share its Campaign; a retry is the same run', async () => {
    const who = await signedIn()
    await send('GET', who.base, undefined, who.auth)
    const path = `${who.base}/learning-to-linkedin/runs`
    const created = await send('POST', path, { runKey: 'monday' }, who.auth)
    expect(created.status).toBe(201)
    const run = runBody.parse(await created.json())
    expect(run.instance.version).toBe(1)
    expect(run.quests.map((q) => q.nodeId)).toEqual(['draft'])
    const quest = await harness.adapters.quests.get(who.guildId, run.quests[0]?.questId ?? '')
    expect(quest).toMatchObject({ campaignId: run.instance.id, state: 'queued' })

    const again = await send('POST', path, { runKey: 'monday' }, who.auth)
    expect(again.status).toBe(200)
    expect(runBody.parse(await again.json()).instance.id).toBe(run.instance.id)
    expect((await harness.adapters.quests.list(who.guildId, { limit: 50 })).quests).toHaveLength(1)

    const runs = z
      .object({ instances: z.array(z.object({ id: z.string() })), next: z.string().nullable() })
      .parse(await (await send('GET', path, undefined, who.auth)).json())
    expect(runs.instances.map((i) => i.id)).toEqual([run.instance.id])

    const state = stateBody.parse(
      await (await send('GET', `${path}/${run.instance.id}`, undefined, who.auth)).json()
    )
    expect(state.nodes.map((n) => [n.id, n.status])).toEqual([
      ['start', 'done'],
      ['draft', 'queued'],
      ['check', 'pending'],
      ['seal', 'pending'],
      ['publish', 'pending'],
    ])
    expect((await send('POST', `${who.base}/nope/runs`, {}, who.auth)).status).toBe(404)
  })

  test('a guild never reads or runs another guild`s rites', async () => {
    const a = await signedIn()
    const b = await signedIn()
    await send('GET', b.base, undefined, b.auth)
    const ghost = crypto.randomUUID()
    const probes: [string, string, unknown?][] = [
      ['GET', ''],
      ['GET', '/learning-to-linkedin'],
      ['GET', '/learning-to-linkedin/versions'],
      ['GET', '/learning-to-linkedin/runs'],
      ['POST', '/learning-to-linkedin/runs', {}],
      ['PUT', '/learning-to-linkedin', { name: 'x', graph: graph() }],
      ['POST', '/learning-to-linkedin/validate', { graph: graph() }],
    ]
    for (const [method, tail, body] of probes) {
      const atB = await send(method, `/guilds/${b.guildId}/rites${tail}`, body, a.auth)
      const atGhost = await send(method, `/guilds/${ghost}/rites${tail}`, body, a.auth)
      expect(atB.status).toBe(404)
      expect(atGhost.status).toBe(404)
      expect((await atB.text()).replaceAll(b.guildId, '<id>')).toBe(
        (await atGhost.text()).replaceAll(ghost, '<id>')
      )
    }
    const theirs = listBody.parse(await (await send('GET', b.base, undefined, b.auth)).json())
    expect(theirs.rites.map((w) => w.latestVersion)).toEqual([1])
    expect((await harness.adapters.quests.list(b.guildId, { limit: 10 })).quests).toEqual([])
    await expectGuildIsolation(devHarness, {
      build: (caller, target) => [`/guilds/${target}/rites`, { headers: { 'x-guild-id': caller } }],
      snapshot: async (guildId) => devHarness.adapters.quests.list(guildId, { limit: 10 }),
    })
  })
})
