import { expect, test } from 'bun:test'
import type { RiteGraph } from '../../../guildd/src/rites/graph'
import { PasskeyRequestError } from '../passkeys'
import {
  confirmRiteVersion,
  listRites,
  loadRite,
  loadRunState,
  publishRite,
  RiteRejected,
  runRite,
  saveRite,
  validateGraph,
} from './api'

const guild = '11111111-1111-4111-8111-111111111111'
const session = { token: 't1', guildId: guild }
const base = `/api/guilds/${guild}/rites`
const graph: RiteGraph = {
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    { id: 'check', type: 'verify', of: 'start' },
  ],
  edges: [{ from: 'start', to: 'check' }],
}

interface Seen {
  url: string
  method: string
  body: unknown
  headers: Headers
}

function fakes(replies: Record<string, { status?: number; body: unknown }>) {
  const seen: Seen[] = []
  const fetcher = async (url: string, init?: RequestInit) => {
    const text = typeof init?.body === 'string' ? init.body : null
    seen.push({
      url,
      method: init?.method ?? 'GET',
      body: text === null ? null : JSON.parse(text),
      headers: new Headers(init?.headers),
    })
    const reply = replies[`${init?.method ?? 'GET'} ${url}`] ?? { status: 404, body: {} }
    return Response.json(reply.body, { status: reply.status ?? 200 })
  }
  const browser = { create: async () => ({}), get: async () => ({ signed: 'abc' }) }
  return { seen, fetcher, browser }
}

const summary = (id: string) => ({
  id,
  name: id,
  latestVersion: 1,
  activeVersion: null,
  updatedAt: '2026-10-20T00:00:00Z',
})

test('listing follows the cursor until the last page', async () => {
  const { seen, fetcher } = fakes({
    [`GET ${base}?limit=50`]: { body: { rites: [summary('a')], next: 'a' } },
    [`GET ${base}?limit=50&after=a`]: { body: { rites: [summary('b')], next: null } },
  })
  expect((await listRites(session, fetcher)).map((w) => w.id)).toEqual(['a', 'b'])
  expect(seen[0]?.headers.get('authorization')).toBe('Bearer t1')
})

test('loading a Rite parses its graph with the shared schema', async () => {
  const doc = {
    riteId: 'w',
    version: 2,
    name: 'W',
    graph,
    classification: 'internal',
    status: 'active',
    basedOn: null,
    createdAt: 'x',
  }
  const { fetcher } = fakes({ [`GET ${base}/w`]: { body: { version: doc, activeVersion: 2 } } })
  const loaded = await loadRite(session, 'w', fetcher)
  expect(loaded?.version.graph).toEqual(graph)
  expect(loaded?.activeVersion).toBe(2)
  const bad = fakes({
    [`GET ${base}/w`]: {
      body: { version: { ...doc, graph: { nodes: [], edges: [] } }, activeVersion: 2 },
    },
  })
  expect(loadRite(session, 'w', bad.fetcher)).rejects.toThrow()
})

test('an unknown Rite loads as null', async () => {
  const { fetcher } = fakes({})
  expect(await loadRite(session, 'nope', fetcher)).toBeNull()
})

test('validate posts the graph and returns the coded errors', async () => {
  const errors = [{ code: 'agent_after_gate', nodeId: 'late', message: 'agent late runs late' }]
  const { seen, fetcher } = fakes({
    [`POST ${base}/w/validate`]: { body: { valid: false, errors } },
  })
  expect(await validateGraph(session, 'w', graph, fetcher)).toEqual(errors)
  expect(seen[0]?.body).toEqual({ graph })
})

test('save puts name and graph and reports the stored draft', async () => {
  const { seen, fetcher } = fakes({
    [`PUT ${base}/w`]: {
      body: { status: 'draft', version: { version: 3, classification: 'widening' } },
    },
  })
  const outcome = await saveRite(session, 'w', { name: 'W', graph }, fetcher)
  expect(outcome).toEqual({ version: 3, status: 'draft', classification: 'widening' })
  expect(seen[0]?.method).toBe('PUT')
  expect(seen[0]?.body).toEqual({ name: 'W', graph })
})

test('a 422 save throws the coded errors so nodes can show them', async () => {
  const errors = [{ code: 'agent_after_gate', nodeId: 'late', message: 'agent late runs late' }]
  const { fetcher } = fakes({
    [`PUT ${base}/w`]: { status: 422, body: { error: 'invalid_rite', errors } },
  })
  const error = await saveRite(session, 'w', { name: 'W', graph }, fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(RiteRejected)
  expect(error instanceof RiteRejected && error.errors).toEqual(errors)
})

test('another refusal is a request error with the server code', async () => {
  const { fetcher } = fakes({ [`PUT ${base}/w`]: { status: 403, body: { error: 'forbidden' } } })
  const error = await saveRite(session, 'w', { name: 'W', graph }, fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
})

test('confirming runs the passkey re-auth and sends the proof', async () => {
  const { seen, fetcher, browser } = fakes({
    'POST /api/session/reauth/begin': { body: { challengeId: 'c', options: { challenge: 'a' } } },
    'POST /api/session/reauth/finish': { body: { proof: 'proof-1' } },
    [`POST ${base}/w/versions/3/confirm`]: { body: { version: 3, status: 'active' } },
  })
  await confirmRiteVersion(session, 'w', 3, fetcher, browser)
  expect(seen[2]?.url).toBe(`${base}/w/versions/3/confirm`)
  expect(seen[2]?.headers.get('x-reauth-proof')).toBe('proof-1')
})

test('a run reports its instance; a refused run keeps the node and the runKey', async () => {
  const ok = fakes({
    [`POST ${base}/w/runs`]: { status: 201, body: { instance: { id: 'r1' }, quests: [] } },
  })
  expect(await runRite(session, 'w', ok.fetcher, 'k1')).toEqual({
    ok: true,
    instanceId: 'r1',
    created: true,
  })
  expect(ok.seen[0]?.body).toEqual({ runKey: 'k1' })
  const refused = fakes({
    [`POST ${base}/w/runs`]: {
      status: 422,
      body: { error: 'hall_paused', nodeId: 'draft', runKey: 'k1' },
    },
  })
  expect(await runRite(session, 'w', refused.fetcher, 'k1')).toEqual({
    ok: false,
    error: 'hall_paused',
    nodeId: 'draft',
    runKey: 'k1',
  })
})

test('a run state lists each node with its status and Quest', async () => {
  const state = {
    instance: { id: 'r1', version: 1, createdAt: 'x', riteId: 'w', runKey: 'k' },
    nodes: [{ id: 'draft', type: 'agent', status: 'running', questId: 'q1' }],
  }
  const { fetcher } = fakes({ [`GET ${base}/w/runs/r1`]: { body: state } })
  expect((await loadRunState(session, 'w', 'r1', fetcher))?.nodes[0]?.status).toBe('running')
})

test('publish sends the active version it was based on; a 202 is a pending widening', async () => {
  const { seen, fetcher } = fakes({
    [`POST ${base}/w/versions/3/publish`]: {
      status: 202,
      body: { status: 'pending', version: { version: 3, classification: 'widening' } },
    },
  })
  expect(await publishRite(session, 'w', 3, 2, fetcher)).toEqual({
    version: 3,
    status: 'pending',
    classification: 'widening',
  })
  expect(seen[0]?.body).toEqual({ basedOn: 2 })
})

test('a stale publish is a request error carrying the server code', async () => {
  const { fetcher } = fakes({
    [`POST ${base}/w/versions/3/publish`]: { status: 409, body: { error: 'stale' } },
  })
  const error = await publishRite(session, 'w', 3, null, fetcher).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(PasskeyRequestError)
  expect(error instanceof PasskeyRequestError && error.code).toBe('stale')
})
