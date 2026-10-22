import { expect, test } from 'bun:test'
import { Hono } from 'hono'
import { z } from 'zod'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryRiteStore } from '../adapters/memory-rite-store'
import { MemorySealStore } from '../adapters/memory-seal-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { ProposalEngine } from '../proposals'
import { RiteEngine } from './engine'
import { mountRiteRoutes } from './routes'
import { LEARNING_TO_LINKEDIN } from './templates'

/** Mounts the routes over an identity stub whose session has the given role and a valid proof. */
async function setup(role: string) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const tripwires = new MemoryTripwireStore(clock)
  const engine = new RiteEngine({
    store: new MemoryRiteStore(clock),
    config,
    quests: new MemoryQuestQueue(clock, () => 0.5),
    tripwires,
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    seals: new MemorySealStore(clock),
    handoffs: new MemoryHandoffStore(),
  })
  const principal = { guildId: guild, memberId: 'm', role }
  const proofs = { spent: 0 }
  const identity = {
    resolveSession: async () => principal,
    consumeReauth: async (_token: string, proof: string) => {
      proofs.spent += 1
      return proof === 'good'
    },
  }
  const app = new Hono()
  const guard = async () => ({ guild })
  mountRiteRoutes(app, {
    rites: engine,
    identity,
    sessionGuildFor: guard,
    guildMasterSessionFor: guard,
  })
  return { app, engine, guild, tripwires, proofs }
}

/** Saves the template as a draft and publishes it; a first version that can post waits pending. */
const pendingRite = async (engine: RiteEngine, guild: string) => {
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  await engine.publish(guild, 'wf', 1, null)
}

test('confirming a pending version needs the Guild Master and a proof', async () => {
  for (const [role, proof, status] of [
    ['member', 'good', 403],
    ['guild_master', 'bad', 403],
    ['guild_master', 'good', 200],
  ] as const) {
    const { app, engine, guild } = await setup(role)
    await pendingRite(engine, guild)
    const res = await app.request(`/guilds/${guild}/rites/wf/versions/1/confirm`, {
      method: 'POST',
      headers: { authorization: 'Bearer t', 'x-reauth-proof': proof },
    })
    expect(res.status).toBe(status)
    expect((await engine.get(guild, 'wf', 1))?.version.status).toBe(
      status === 200 ? 'active' : 'pending'
    )
  }
})

test('confirming on an archived Rite is 409 rite_archived, spends no proof and leaves the version pending', async () => {
  const { app, engine, guild, proofs } = await setup('guild_master')
  await pendingRite(engine, guild)
  await engine.archive(guild, 'wf')
  const res = await app.request(`/guilds/${guild}/rites/wf/versions/1/confirm`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'x-reauth-proof': 'good' },
  })
  expect(res.status).toBe(409)
  expect(z.object({ error: z.string() }).parse(await res.json()).error).toBe('rite_archived')
  expect(proofs.spent).toBe(0)
  expect((await engine.get(guild, 'wf', 1))?.version.status).toBe('pending')
})

test('a run that fails part-way returns its runKey, so a retry resumes the same run', async () => {
  const { app, engine, guild, tripwires } = await setup('guild_master')
  await pendingRite(engine, guild)
  const confirmed = await app.request(`/guilds/${guild}/rites/wf/versions/1/confirm`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'x-reauth-proof': 'good' },
  })
  expect(confirmed.status).toBe(200)
  await tripwires.pause(guild, { hallId: 'heralds', tripwire: 'manual', observed: 1, threshold: 1 })
  const run = () =>
    app.request(`/guilds/${guild}/rites/wf/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
  const failed = await run()
  expect(failed.status).toBe(422)
  const body = z.object({ error: z.string(), runKey: z.string().min(1) }).parse(await failed.json())
  expect(body.error).toBe('hall_paused')
  const retry = await app.request(`/guilds/${guild}/rites/wf/runs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ runKey: body.runKey }),
  })
  expect(z.object({ runKey: z.string() }).parse(await retry.json()).runKey).toBe(body.runKey)
})

const publish = (app: Hono, guild: string, version: number, body: unknown) =>
  app.request(`/guilds/${guild}/rites/wf/versions/${version}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer t' },
    body: JSON.stringify(body),
  })

test('PUT saves a draft; publishing a widening draft is 202 and goes live only on confirm', async () => {
  const { app, engine, guild } = await setup('guild_master')
  const put = await app.request(`/guilds/${guild}/rites/wf`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'x', graph: LEARNING_TO_LINKEDIN }),
  })
  expect(put.status).toBe(200)
  expect(await put.json()).toMatchObject({ status: 'draft', version: { version: 1 } })
  expect((await engine.get(guild, 'wf'))?.activeVersion).toBeNull()
  const published = await publish(app, guild, 1, { basedOn: null })
  expect(published.status).toBe(202)
  expect(await published.json()).toMatchObject({ status: 'pending', version: { version: 1 } })
  expect((await engine.get(guild, 'wf'))?.activeVersion).toBeNull()
})

test('publish is refused 409 stale when the active version moved, 400 without basedOn', async () => {
  const { app, engine, guild } = await setup('guild_master')
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  expect((await publish(app, guild, 1, { basedOn: 4 })).status).toBe(409)
  expect(await (await publish(app, guild, 1, { basedOn: 4 })).json()).toEqual({ error: 'stale' })
  expect((await publish(app, guild, 1, {})).status).toBe(400)
  expect((await publish(app, guild, 7, { basedOn: null })).status).toBe(404)
})

test('publish is scoped to the session guild: another guild cannot publish a draft', async () => {
  const { engine, guild } = await setup('guild_master')
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  const other = crypto.randomUUID()
  const app = new Hono()
  const guard = async () => ({ guild: other })
  mountRiteRoutes(app, {
    rites: engine,
    identity: { resolveSession: async () => null, consumeReauth: async () => false },
    sessionGuildFor: guard,
    guildMasterSessionFor: guard,
  })
  expect((await publish(app, other, 1, { basedOn: null })).status).toBe(404)
  expect((await engine.get(guild, 'wf', 1))?.version.status).toBe('draft')
})

test('confirming a pending version is refused 409 stale once the active version moved', async () => {
  const { app, engine, guild } = await setup('guild_master')
  await pendingRite(engine, guild)
  await engine.confirm(guild, 'wf', 1)
  const wider = structuredClone(LEARNING_TO_LINKEDIN)
  const agent = wider.nodes.find((n) => n.type === 'agent')
  if (agent?.type !== 'agent') {
    throw new Error('template changed')
  }
  agent.maxUsd = 9
  await engine.save(guild, 'wf', { name: 'x', graph: wider })
  await engine.publish(guild, 'wf', 2, 1)
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  await engine.publish(guild, 'wf', 3, 1)
  const res = await app.request(`/guilds/${guild}/rites/wf/versions/2/confirm`, {
    method: 'POST',
    headers: { authorization: 'Bearer t', 'x-reauth-proof': 'good' },
  })
  expect(res.status).toBe(409)
  expect(await res.json()).toEqual({ error: 'stale' })
  expect((await engine.get(guild, 'wf'))?.activeVersion).toBe(3)
})

const versionRows = z.object({
  versions: z.array(
    z.object({ version: z.number(), status: z.string(), classification: z.string() })
  ),
})

test('the versions route returns status and classification per version, newest first', async () => {
  const { app, engine, guild } = await setup('guild_master')
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  await engine.publish(guild, 'wf', 1, null)
  await engine.confirm(guild, 'wf', 1)
  await engine.save(guild, 'wf', { name: 'y', graph: LEARNING_TO_LINKEDIN })
  const res = await app.request(`/guilds/${guild}/rites/wf/versions`)
  expect(res.status).toBe(200)
  const body = versionRows.parse(await res.json())
  expect(body.versions.map((v) => [v.version, v.status])).toEqual([
    [2, 'draft'],
    [1, 'active'],
  ])
  expect(body.versions.every((v) => v.classification.length > 0)).toBe(true)
})

test('the versions route lists only the session guild: another guild sees none', async () => {
  const { engine, guild } = await setup('guild_master')
  await engine.save(guild, 'wf', { name: 'x', graph: LEARNING_TO_LINKEDIN })
  const other = crypto.randomUUID()
  const app = new Hono()
  const guard = async () => ({ guild: other })
  mountRiteRoutes(app, {
    rites: engine,
    identity: { resolveSession: async () => null, consumeReauth: async () => false },
    sessionGuildFor: guard,
    guildMasterSessionFor: guard,
  })
  const res = await app.request(`/guilds/${other}/rites/wf/versions`)
  expect(versionRows.parse(await res.json()).versions).toEqual([])
})

test('the versions route and a version read carry basedOn: the active version a pending one waits on', async () => {
  const { app, engine, guild } = await setup('guild_master')
  await pendingRite(engine, guild)
  await engine.confirm(guild, 'wf', 1)
  const wider = structuredClone(LEARNING_TO_LINKEDIN)
  const agent = wider.nodes.find((n) => n.type === 'agent')
  if (agent?.type !== 'agent') {
    throw new Error('template changed')
  }
  agent.maxUsd = 9
  await engine.save(guild, 'wf', { name: 'x', graph: wider })
  await engine.publish(guild, 'wf', 2, 1)
  const list = z
    .object({
      versions: z.array(z.object({ version: z.number(), basedOn: z.number().nullable() })),
    })
    .parse(await (await app.request(`/guilds/${guild}/rites/wf/versions`)).json())
  expect(list.versions.map((v) => [v.version, v.basedOn])).toEqual([
    [2, 1],
    [1, null],
  ])
  const one = z
    .object({ version: z.object({ basedOn: z.number().nullable() }) })
    .parse(await (await app.request(`/guilds/${guild}/rites/wf?version=2`)).json())
  expect(one.version.basedOn).toBe(1)
})
