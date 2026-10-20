import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryNoteStore } from '../adapters/memory-note-store'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryToolsetStore } from '../adapters/memory-toolset-store'
import type { Quest } from '../ports/quest-queue'
import { callTool, ScriptedMember } from '../testing/scripted-member'
import { McpGateway, type McpGatewayDeps } from './gateway'
import { TOOL_CATALOG, type ToolDef } from './tools'

const lease = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })

async function setup(overrides: Partial<McpGatewayDeps> = {}) {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const config = new MemoryConfigStore(clock)
  const notes = new MemoryNoteStore()
  const objectStore = new MemoryObjectStore()
  const handoffs = new MemoryHandoffStore()
  const toolsets = new MemoryToolsetStore()
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const deps: McpGatewayDeps = {
    quests,
    config,
    notes,
    objectStore,
    handoffs,
    toolsets,
    keys,
    clock,
    ...overrides,
  }
  const gateway = new McpGateway(deps)
  const transport = (request: object) => gateway.handle(request)
  const post = async (over: Partial<Parameters<typeof quests.post>[1]> = {}): Promise<Quest> =>
    (
      await quests.post(guild, {
        jobKey: crypto.randomUUID(),
        templateId: 'herald-brief',
        hallId: 'heralds',
        rank: 'journeyman',
        dataClass: 'internal',
        title: 'Draft the brief',
        ownerId: 'heralds-member-2',
        doneCondition: 'A draft brief is filed in the Archive',
        roundLimit: 2,
        ...over,
      })
    ).quest
  /** Claims `quest` through the gateway and returns its lease handle. */
  const claim = async (quest: Quest) => {
    const out = await callTool(transport, 'claim_quest', {
      assignment: await gateway.assign(guild, quest),
    })
    return { out, lease: out.isError || out.rpcError ? null : lease.parse(out.data.lease) }
  }
  return {
    gateway,
    deps,
    transport,
    clock,
    quests,
    notes,
    objectStore,
    handoffs,
    guild,
    post,
    claim,
  }
}

const handoffFor = (hash: string) => ({
  goal: 'Draft the brief',
  doneCondition: 'A draft brief is filed in the Archive',
  met: true,
  evidence: [{ kind: 'artifact', ref: hash }],
  openItems: [],
  artifacts: [hash],
})

type Setup = Awaited<ReturnType<typeof setup>>
const put =
  (t: Setup) =>
  async (l: z.infer<typeof lease>, text: string): Promise<string> =>
    String(
      (
        await callTool(t.transport, 'put_artifact', {
          lease: l,
          contentBase64: Buffer.from(text).toString('base64'),
        })
      ).data.hash
    )

describe('MCP gateway', () => {
  test('a scripted Member claims, reads the Brief, files an artifact and completes with a Handoff', async () => {
    const s = await setup()
    const quest = await s.post()
    const member = new ScriptedMember(s.transport, {
      goal: 'Draft the brief',
      output: (brief) => `Draft for: ${brief.split('\n').find((l) => l.startsWith('Quest:'))}`,
    })
    const run = await member.run(await s.gateway.assign(s.guild, quest))
    expect(run.brief).toContain('Done when: A draft brief is filed in the Archive')
    expect(run.completion).toMatchObject({ status: 200, isError: false })
    expect((await s.quests.get(s.guild, quest.id))?.state).toBe('done')
    expect((await s.handoffs.get(s.guild, quest.id, 1))?.handoff).toEqual(run.handoff)
    const bytes = await s.objectStore.get(s.guild, run.artifactHash)
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toContain('Draft for:')
    // The lease ended with the Quest: the same handle opens nothing now.
    const after = await callTool(s.transport, 'get_artifact', {
      lease: run.lease,
      hash: run.artifactHash,
    })
    expect(after).toMatchObject({ status: 401, rpcError: 'lease_expired' })
  })

  test('tools/list shows the role’s frozen tools in catalogue order', async () => {
    const s = await setup()
    const quest = await s.post()
    const res = await s.transport({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { assignment: await s.gateway.assign(s.guild, quest) },
    })
    const names = z
      .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
      .parse(res.body)
      .result.tools.map((t) => t.name)
    expect(names).toEqual(TOOL_CATALOG.map((t) => t.name))
  })

  describe('lease authority', () => {
    test('calls with no token, a garbled one or a forged one are refused', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: l } = await s.claim(quest)
      expect(l).not.toBeNull()
      const real = lease.parse(l)
      for (const token of ['x', `${real.token}0`, `e30.${'0'.repeat(64)}`]) {
        const out = await callTool(s.transport, 'get_artifact', {
          lease: { ...real, token },
          hash: 'a'.repeat(64),
        })
        expect(out).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
      }
      const none = await callTool(s.transport, 'get_artifact', { hash: 'a'.repeat(64) })
      expect(none.status).toBe(200)
      expect(none.rpcError).toBe('invalid_arguments')
    })

    test('a lease that has lapsed is refused', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      s.clock.advance(60 * 60 * 1000)
      const out = await callTool(s.transport, 'get_artifact', {
        lease: l,
        hash: 'a'.repeat(64),
      })
      expect(out).toMatchObject({ status: 401, rpcError: 'lease_expired' })
    })

    test('a token for one Quest does not open another', async () => {
      const s = await setup()
      const q1 = await s.post()
      const q2 = await s.post({ campaignId: undefined })
      const { lease: l1 } = await s.claim(q1)
      const { lease: l2 } = await s.claim(q2)
      const out = await callTool(s.transport, 'get_artifact', {
        lease: { ...lease.parse(l1), questId: lease.parse(l2).questId },
        hash: 'a'.repeat(64),
      })
      expect(out).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
    })

    test('after a reclaim the old attempt is fenced out', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: first } = await s.claim(quest)
      s.clock.advance(60 * 60 * 1000)
      const { lease: second } = await s.claim(quest)
      expect(lease.parse(second).attempt).toBe(2)
      const stale = await callTool(s.transport, 'get_artifact', {
        lease: first,
        hash: 'a'.repeat(64),
      })
      expect(stale).toMatchObject({ status: 401 })
      const ok = await callTool(s.transport, 'get_artifact', {
        lease: second,
        hash: 'a'.repeat(64),
      })
      expect(ok.status).toBe(200)
    })

    test('an assignment cannot be used by another Member or after it lapses', async () => {
      const s = await setup()
      const quest = await s.post()
      const other = await s.post({ ownerId: 'heralds-member-1', rank: 'apprentice' })
      const forged = await s.gateway.assign(s.guild, { ...quest, ownerId: 'heralds-member-1' })
      expect(await callTool(s.transport, 'claim_quest', { assignment: forged })).toMatchObject({
        status: 401,
        rpcError: 'invalid_assignment',
      })
      expect((await s.quests.get(s.guild, quest.id))?.state).toBe('queued')
      expect(other.state).toBe('queued')
      const late = await s.gateway.assign(s.guild, quest)
      s.clock.advance(60 * 60 * 1000)
      const out = await callTool(s.transport, 'claim_quest', { assignment: late })
      expect(out).toMatchObject({ status: 401, rpcError: 'invalid_assignment' })
    })
  })

  describe('complete_quest', () => {
    test('an invalid Handoff is rejected with the paths and reasons', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const out = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: { goal: '', met: 'yes' },
      })
      expect(out.isError).toBe(true)
      expect(out.data.error).toBe('invalid_handoff')
      const issues = z
        .array(z.object({ path: z.string(), message: z.string() }))
        .parse(out.data.issues)
      expect(issues.map((i) => i.path)).toEqual(expect.arrayContaining(['goal', 'met']))
      expect((await s.quests.get(s.guild, lease.parse(l).questId))?.state).toBe('active')
    })

    test('a Handoff marked met without evidence is rejected', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const hash = await put(s)(lease.parse(l), 'x')
      const out = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: { ...handoffFor(hash), evidence: [] },
      })
      expect(out.isError).toBe(true)
      expect(JSON.stringify(out.data.issues)).toContain('evidence')
    })

    test('a Handoff citing a done-condition other than the Quest’s, or an artifact it does not hold, is rejected', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const hash = await put(s)(lease.parse(l), 'x')
      const wrong = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: { ...handoffFor(hash), doneCondition: 'Something easier' },
      })
      expect(wrong.data.error).toBe('invalid_handoff')
      const missing = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: handoffFor('b'.repeat(64)),
      })
      expect(missing.data.error).toBe('invalid_handoff')
      expect(JSON.stringify(missing.data.issues)).toContain('artifacts')
    })

    test('completing twice with the same Handoff is one effect; a different one is refused', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const hash = await put(s)(lease.parse(l), 'x')
      const first = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: handoffFor(hash),
      })
      const again = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: handoffFor(hash),
      })
      expect([first.isError, again.isError]).toEqual([false, false])
      const other = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: { ...handoffFor(hash), goal: 'Changed my mind' },
      })
      expect(other.data.error).toBe('handoff_conflict')
    })
  })

  describe('Archive scope', () => {
    test('a Member reads and writes only the notes of its own Hall', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const written = await callTool(s.transport, 'write_archive', {
        lease: l,
        title: 'Launch plan',
        body: 'launch timeline',
        claim: 'assumption',
      })
      expect(written.isError).toBe(false)
      // A note of another Hall, written straight into the store.
      const foreign = await s.notes.add(s.guild, {
        kind: 'text',
        title: '[health] Launch diagnosis',
        body: 'launch secrets',
        claim: 'assumption',
      })
      const found = await callTool(s.transport, 'read_archive', { lease: l, query: 'launch' })
      const titles = z.array(z.object({ title: z.string() })).parse(found.data.notes)
      expect(titles.map((n) => n.title)).toEqual(['[heralds] Launch plan'])
      const byId = await callTool(s.transport, 'read_archive', { lease: l, noteId: foreign.id })
      expect(byId).toMatchObject({ isError: true })
      expect(byId.data.error).toBe('not_found')
      const ghost = await callTool(s.transport, 'read_archive', {
        lease: l,
        noteId: crypto.randomUUID(),
      })
      expect(ghost.data).toEqual(byId.data)
    })

    test('a fact needs evidence, and an apprentice has no write tool', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const fact = await callTool(s.transport, 'write_archive', {
        lease: l,
        title: 'Claim',
        body: 'b',
        claim: 'fact',
      })
      expect(fact.data.error).toBe('evidence_required')
      const apprentice = await s.post({ rank: 'apprentice', ownerId: 'heralds-member-1' })
      const { lease: al } = await s.claim(apprentice)
      const out = await callTool(s.transport, 'write_archive', {
        lease: al,
        title: 'x',
        body: 'b',
        claim: 'assumption',
      })
      expect(out.rpcError).toBe('unknown_tool')
    })
  })

  describe('artifacts', () => {
    test('a Quest reaches only the artifacts it holds', async () => {
      const s = await setup()
      const q1 = await s.post()
      const q2 = await s.post()
      const { lease: l1 } = await s.claim(q1)
      const { lease: l2 } = await s.claim(q2)
      const mine = await put(s)(lease.parse(l1), 'mine')
      const theirs = await callTool(s.transport, 'get_artifact', { lease: l2, hash: mine })
      expect(theirs.isError).toBe(true)
      expect(theirs.data.error).toBe('not_found')
    })
  })

  describe('frozen tool lists', () => {
    const extra: ToolDef = {
      name: 'search_web',
      description: 'added later',
      roles: ['journeyman'],
      args: z.strictObject({ lease: z.unknown() }),
    }
    const listOf = async (t: (r: object) => Promise<{ body: unknown }>, params: object) =>
      z
        .object({ result: z.object({ tools: z.array(z.object({ name: z.string() })) }) })
        .parse((await t({ jsonrpc: '2.0', id: 1, method: 'tools/list', params })).body)
        .result.tools.map((x) => x.name)

    test('a tool added to the catalogue mid-Campaign is not exposed to that Campaign', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post({ campaignId: 'launch' }))
      const hash = await put(s)(lease.parse(l), 'x')
      await callTool(s.transport, 'complete_quest', { lease: l, handoff: handoffFor(hash) })
      // The catalogue gains a tool; a new gateway over the same stores serves the Campaign's next Quest.
      const later = new McpGateway({ ...s.deps, catalog: [...TOOL_CATALOG, extra] })
      const via = (r: object) => later.handle(r)
      const second = await s.post({ campaignId: 'launch' })
      const names = await listOf(via, { assignment: await later.assign(s.guild, second) })
      expect(names).toEqual(TOOL_CATALOG.map((t) => t.name))
      const claimed = await callTool(via, 'claim_quest', {
        assignment: await later.assign(s.guild, second),
      })
      const called = await callTool(via, 'search_web', { lease: claimed.data.lease })
      expect(called.rpcError).toBe('unknown_tool')
    })

    test('a Campaign that starts after the change gets the new tool', async () => {
      const s = await setup()
      const later = new McpGateway({ ...s.deps, catalog: [...TOOL_CATALOG, extra] })
      const quest = await s.post({ campaignId: 'next' })
      const names = await listOf((r) => later.handle(r), {
        assignment: await later.assign(s.guild, quest),
      })
      expect(names.at(-1)).toBe('search_web')
    })
  })

  test('a request that is not a JSON-RPC call is refused, and notifications get no body', async () => {
    const s = await setup()
    expect((await s.transport({ nonsense: true })).status).toBe(400)
    expect(await s.transport({ jsonrpc: '2.0', method: 'notifications/initialized' })).toEqual({
      status: 202,
      body: null,
    })
    const init = await s.transport({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    expect(JSON.stringify(init.body)).toContain('2026-07-28')
  })
})
