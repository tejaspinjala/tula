import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryGateStore } from '../adapters/memory-gate-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryNoteStore } from '../adapters/memory-note-store'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryToolsetStore } from '../adapters/memory-toolset-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import type { GuildConfig } from '../guild-config'
import type { Quest } from '../ports/quest-queue'
import { ProposalEngine } from '../proposals'
import { callTool, ScriptedMember } from '../testing/scripted-member'
import { McpGateway, type McpGatewayDeps } from './gateway'
import { MAX_PROPOSALS_PER_QUEST, TOOL_CATALOG, type ToolDef } from './tools'

const SPAWN_TOOLS = ['spawn_subquest', 'await_children', 'child_results']
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
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    keys,
    clock,
    tripwires: new MemoryTripwireStore(clock),
    gates: new MemoryGateStore(),
    retireRun: async () => {},
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

  describe('read_brief', () => {
    test('returns the deterministic Brief for the leased Quest, with no secrets', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: l } = await s.claim(quest)
      const first = await callTool(s.transport, 'read_brief', { lease: l })
      expect(first).toMatchObject({ status: 200, isError: false })
      const brief = z.string().parse(first.data.brief)
      expect(brief).toContain('Done when: A draft brief is filed in the Archive')
      expect(brief).toContain(`Quest: Draft the brief (${quest.id})`)
      expect(brief).not.toContain(lease.parse(l).token)
      expect(await callTool(s.transport, 'read_brief', { lease: l })).toEqual(first)
    })

    test('lists the Hall notes by id and title only, never their body', async () => {
      const s = await setup()
      const note = await s.notes.add(
        s.guild,
        { kind: 'text', title: 'Tone guide', body: 'SECRET-BODY-TEXT', claim: 'assumption' },
        'heralds'
      )
      const { lease: l } = await s.claim(await s.post())
      const brief = z
        .string()
        .parse((await callTool(s.transport, 'read_brief', { lease: l })).data.brief)
      expect(brief).toContain(`note ${note.id}: Tone guide`)
      expect(brief).not.toContain('SECRET-BODY-TEXT')
    })

    test('a forged, foreign or lapsed lease is refused', async () => {
      const s = await setup()
      const q1 = await s.post()
      const q2 = await s.post()
      const { lease: l1 } = await s.claim(q1)
      const { lease: l2 } = await s.claim(q2)
      const forged = await callTool(s.transport, 'read_brief', {
        lease: { ...lease.parse(l1), token: 'x' },
      })
      expect(forged).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
      const foreign = await callTool(s.transport, 'read_brief', {
        lease: { ...lease.parse(l1), questId: lease.parse(l2).questId },
      })
      expect(foreign).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
      s.clock.advance(60 * 60 * 1000)
      const lapsed = await callTool(s.transport, 'read_brief', { lease: l1 })
      expect(lapsed).toMatchObject({ status: 401, rpcError: 'lease_expired' })
    })

    test('a superseded attempt is fenced out', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: first } = await s.claim(quest)
      s.clock.advance(60 * 60 * 1000)
      const { lease: second } = await s.claim(quest)
      const stale = await callTool(s.transport, 'read_brief', { lease: first })
      expect(stale).toMatchObject({ status: 401, rpcError: 'lease_expired' })
      expect((await callTool(s.transport, 'read_brief', { lease: second })).status).toBe(200)
    })

    test('a barred guild is denied', async () => {
      const gates = new MemoryGateStore()
      const s = await setup({ gates })
      const { lease: l } = await s.claim(await s.post())
      await gates.bar({ guildId: s.guild, memberId: 'owner' }, 'guild')
      const out = await callTool(s.transport, 'read_brief', { lease: l })
      expect(out).toMatchObject({ status: 401, rpcError: 'gates_barred' })
    })

    const briefOf = async (s: Setup, l: unknown): Promise<string> =>
      z.string().parse((await callTool(s.transport, 'read_brief', { lease: l })).data.brief)
    const assume = (title: string) => ({
      kind: 'text' as const,
      title,
      body: 'b',
      claim: 'assumption' as const,
    })

    test("another Hall's, a Hall-less and another guild's notes are absent from the Brief", async () => {
      const s = await setup()
      const mine = await s.notes.add(s.guild, assume('Mine'), 'heralds')
      const otherHall = await s.notes.add(s.guild, assume('Other Hall'), 'scribes')
      const noHall = await s.notes.add(s.guild, assume('Guild Master'))
      const otherGuild = crypto.randomUUID()
      const foreign = await s.notes.add(otherGuild, assume('Other Guild'), 'heralds')
      const { lease: l } = await s.claim(await s.post())
      const brief = await briefOf(s, l)
      expect(brief).toContain(`note ${mine.id}: Mine`)
      for (const n of [otherHall, noHall, foreign]) {
        expect(brief).not.toContain(n.id)
      }
    })

    test("a lease from one guild cannot read another guild's Quest Brief", async () => {
      const s = await setup()
      const other = crypto.randomUUID()
      await s.deps.config.seed(other)
      const theirs = (
        await s.deps.quests.post(other, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-brief',
          hallId: 'heralds',
          rank: 'journeyman',
          dataClass: 'internal',
          title: 'Their quest',
          ownerId: 'heralds-member-2',
          doneCondition: 'Their secret done-condition',
          roundLimit: 2,
        })
      ).quest
      const { lease: mine } = await s.claim(await s.post())
      const out = await callTool(s.transport, 'read_brief', {
        lease: { ...lease.parse(mine), questId: theirs.id },
      })
      expect(out).toMatchObject({ status: 401, rpcError: 'invalid_lease' })
      expect(JSON.stringify(out)).not.toContain('Their secret')
    })

    test('lists at most 20 notes and stays within the token cap', async () => {
      const s = await setup()
      for (let i = 0; i < 25; i++) {
        await s.notes.add(s.guild, assume(`T${i} ${'x'.repeat(900)}`), 'heralds')
      }
      const { lease: l } = await s.claim(await s.post())
      const brief = await briefOf(s, l)
      expect(
        brief.split('\n').filter((line) => line.startsWith('note ')).length
      ).toBeLessThanOrEqual(20)
      expect(Math.ceil(brief.length / 4)).toBeLessThanOrEqual(2000)
      expect(brief).toContain('more pointers omitted')
    })

    test('a Quest too large for the Brief cap is refused with a coded error, on read and on claim', async () => {
      const s = await setup()
      const tight = new McpGateway({ ...s.deps, briefTokenCap: 10 })
      const via = (r: object) => tight.handle(r)
      const quest = await s.post({ doneCondition: 'x'.repeat(200) })
      const claimed = await callTool(via, 'claim_quest', {
        assignment: await tight.assign(s.guild, quest),
      })
      expect(claimed).toMatchObject({ isError: true, data: { error: 'brief_too_large' } })
      const handle = await tight.lease(s.guild, (await s.quests.get(s.guild, quest.id)) ?? quest)
      const out = await callTool(via, 'read_brief', { lease: handle })
      expect(out).toMatchObject({ isError: true, data: { error: 'brief_too_large' } })
    })

    test('a Campaign started before the tool existed never sees it', async () => {
      const s = await setup()
      const withoutIt = TOOL_CATALOG.filter((t) => t.name !== 'read_brief')
      const old = new McpGateway({ ...s.deps, catalog: withoutIt })
      const first = await s.post({ campaignId: 'old' })
      const claimed = await callTool((r) => old.handle(r), 'claim_quest', {
        assignment: await old.assign(s.guild, first),
      })
      // The catalogue gains read_brief; the Campaign's frozen list stays as it was.
      const out = await callTool(s.transport, 'read_brief', { lease: claimed.data.lease })
      expect(out.rpcError).toBe('unknown_tool')
    })
  })

  describe('submit_proposal', () => {
    const announce = (s: Setup) =>
      s.post({
        templateId: 'herald-announcement',
        rank: 'apprentice',
        dataClass: 'public',
        ownerId: 'heralds-member-1',
        doneCondition: 'An announcement draft is ready for a Seal',
        roundLimit: 3,
      })
    const draft = { text: 'Guild update: the hall opens at dawn.', evidenceLinks: [] }

    test('files the draft as a Proposal for the leased Quest, with the Verdict bound to its hash', async () => {
      const s = await setup()
      const quest = await announce(s)
      const { lease: l } = await s.claim(quest)
      const out = await callTool(s.transport, 'submit_proposal', { lease: l, ...draft })
      expect(out.isError).toBe(false)
      const stored = await s.deps.proposals.latestForQuest(s.guild, quest.id)
      expect(stored).toMatchObject({
        questId: quest.id,
        author: 'heralds-member-1',
        kind: 'post',
        content: draft.text,
      })
      expect(out.data).toMatchObject({ hash: stored?.hash, passed: true })
      expect((await s.deps.proposals.verdictFor(s.guild, String(stored?.hash)))?.passed).toBe(true)
    })

    test('evidence links join the filed text and meet the same Verdict checks', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await announce(s))
      const out = await callTool(s.transport, 'submit_proposal', {
        lease: l,
        text: 'Read more.',
        evidenceLinks: ['https://example.com/a'],
      })
      expect(out.isError).toBe(false)
      const stored = await s.deps.proposals.latestForQuest(s.guild, lease.parse(l).questId)
      expect(stored?.content).toContain('Read more.')
      expect(stored?.content).toContain('https://example.com/a')
    })

    test('a failing draft is stored with a failing Verdict, not refused', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await announce(s))
      const out = await callTool(s.transport, 'submit_proposal', {
        lease: l,
        text: 'contact me at someone@example.com',
        evidenceLinks: [],
      })
      expect(out.isError).toBe(false)
      expect(out.data.passed).toBe(false)
    })

    test('the same draft twice is one Proposal; a changed one is a new Proposal', async () => {
      const s = await setup()
      const quest = await announce(s)
      const { lease: l } = await s.claim(quest)
      const first = await callTool(s.transport, 'submit_proposal', { lease: l, ...draft })
      const again = await callTool(s.transport, 'submit_proposal', { lease: l, ...draft })
      expect(again.data.hash).toBe(first.data.hash)
      const edited = await callTool(s.transport, 'submit_proposal', {
        lease: l,
        text: 'Guild update: the hall opens at noon.',
        evidenceLinks: [],
      })
      expect(edited.data.hash).not.toBe(first.data.hash)
      const page = await s.deps.proposals.list(s.guild, { limit: 10 })
      expect(page.proposals).toHaveLength(2)
    })

    test('past the per-Quest cap a new draft is refused and writes no row', async () => {
      const s = await setup()
      const quest = await announce(s)
      const { lease: l } = await s.claim(quest)
      for (let i = 0; i < MAX_PROPOSALS_PER_QUEST; i++) {
        const out = await callTool(s.transport, 'submit_proposal', {
          lease: l,
          text: `Draft number ${i}`,
          evidenceLinks: [],
        })
        expect(out.isError).toBe(false)
      }
      const over = await callTool(s.transport, 'submit_proposal', {
        lease: l,
        text: 'One draft too many',
        evidenceLinks: [],
      })
      expect(over).toMatchObject({ isError: true })
      expect(over.data.error).toBe('proposal_cap')
      const rows = await s.deps.proposals.listForQuest(s.guild, quest.id, 50)
      expect(rows).toHaveLength(MAX_PROPOSALS_PER_QUEST)
    })

    test('re-submitting an older draft is refused; the latest stays idempotent', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await announce(s))
      const file = (text: string) =>
        callTool(s.transport, 'submit_proposal', { lease: l, text, evidenceLinks: [] })
      const a = await file('Draft A')
      const b = await file('Draft B')
      const again = await file('Draft A')
      expect(again.isError).toBe(true)
      expect(again.data.error).toBe('proposal_superseded')
      const latest = await file('Draft B')
      expect(latest.isError).toBe(false)
      expect(latest.data.id).toBe(b.data.id)
      expect(a.data.id).not.toBe(b.data.id)
    })

    test('rejects oversized text, too many or non-https links', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await announce(s))
      const bad = [
        { text: '', evidenceLinks: [] },
        { text: 'x'.repeat(20001), evidenceLinks: [] },
        { text: 'ok', evidenceLinks: ['http://example.com'] },
        { text: 'ok', evidenceLinks: ['javascript:alert(1)'] },
        { text: 'ok', evidenceLinks: ['https://a:b@x.com'] },
        { text: 'ok', evidenceLinks: ['https://127.0.0.1/x'] },
        { text: 'ok', evidenceLinks: ['https://printer.local/x'] },
        { text: 'ok', evidenceLinks: ['https://localhost/x'] },
        { text: 'ok', evidenceLinks: [`https://example.com/${'a'.repeat(2100)}`] },
        { text: 'ok', evidenceLinks: Array.from({ length: 11 }, (_, i) => `https://e.com/${i}`) },
      ]
      for (const args of bad) {
        const out = await callTool(s.transport, 'submit_proposal', { lease: l, ...args })
        expect(out.rpcError).toBe('invalid_arguments')
      }
      expect((await s.deps.proposals.list(s.guild, { limit: 10 })).proposals).toHaveLength(0)
    })

    test('a barred guild, a forged lease and a lapsed lease are refused with nothing stored', async () => {
      const gates = new MemoryGateStore()
      const s = await setup({ gates })
      const { lease: l } = await s.claim(await announce(s))
      const forged = await callTool(s.transport, 'submit_proposal', {
        lease: { ...lease.parse(l), token: 'nope' },
        ...draft,
      })
      expect(forged.rpcError).toBe('invalid_lease')
      s.clock.advance(60 * 60 * 1000)
      const lapsed = await callTool(s.transport, 'submit_proposal', { lease: l, ...draft })
      expect(lapsed.rpcError).toBe('lease_expired')
      await gates.bar({ guildId: s.guild, memberId: 'owner' }, 'guild')
      const barred = await callTool(s.transport, 'submit_proposal', { lease: l, ...draft })
      expect(barred).toMatchObject({ status: 401, rpcError: 'gates_barred' })
      expect((await s.deps.proposals.list(s.guild, { limit: 10 })).proposals).toHaveLength(0)
    })

    test('a lease cannot file a Proposal for another Quest, or into another guild', async () => {
      const s = await setup()
      const { lease: mine } = await s.claim(await announce(s))
      const other = crypto.randomUUID()
      await s.deps.config.seed(other)
      const theirs = (
        await s.deps.quests.post(other, {
          jobKey: crypto.randomUUID(),
          templateId: 'herald-announcement',
          hallId: 'heralds',
          rank: 'apprentice',
          dataClass: 'public',
          title: 'Theirs',
          ownerId: 'heralds-member-1',
          doneCondition: 'An announcement draft is ready for a Seal',
          roundLimit: 3,
        })
      ).quest
      const out = await callTool(s.transport, 'submit_proposal', {
        lease: { ...lease.parse(mine), questId: theirs.id },
        ...draft,
      })
      expect(out.rpcError).toBe('invalid_lease')
      expect(await s.deps.proposals.latestForQuest(other, theirs.id)).toBeNull()
      expect((await s.deps.proposals.list(other, { limit: 10 })).proposals).toHaveLength(0)
    })

    test('a Campaign started before the tool existed never sees it', async () => {
      const s = await setup()
      const old = new McpGateway({
        ...s.deps,
        catalog: TOOL_CATALOG.filter((t) => t.name !== 'submit_proposal'),
      })
      const first = await announce(s)
      const claimed = await callTool((r) => old.handle(r), 'claim_quest', {
        assignment: await old.assign(s.guild, first),
      })
      const out = await callTool(s.transport, 'submit_proposal', {
        lease: claimed.data.lease,
        ...draft,
      })
      expect(out.rpcError).toBe('unknown_tool')
    })

    test('read_brief tells the worker whether the Quest needs a Seal', async () => {
      const s = await setup()
      const { lease: sealed } = await s.claim(await announce(s))
      expect((await callTool(s.transport, 'read_brief', { lease: sealed })).data.requiresSeal).toBe(
        true
      )
      const { lease: plain } = await s.claim(await s.post())
      expect((await callTool(s.transport, 'read_brief', { lease: plain })).data.requiresSeal).toBe(
        false
      )
    })
  })

  describe('complete_quest', () => {
    test('a Quest whose template requires a Seal ends awaiting_seal after complete_quest, never done', async () => {
      const s = await setup()
      const quest = await s.post({
        templateId: 'herald-announcement',
        rank: 'apprentice',
        dataClass: 'public',
        ownerId: 'heralds-member-1',
        doneCondition: 'An announcement draft is ready for a Seal',
        roundLimit: 3,
      })
      const { lease: l } = await s.claim(quest)
      const hash = await put(s)(lease.parse(l), 'Hello world')
      const out = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: {
          ...handoffFor(hash),
          doneCondition: 'An announcement draft is ready for a Seal',
        },
      })
      expect(out.data.state).toBe('awaiting_seal')
      expect((await s.quests.get(s.guild, quest.id))?.state).toBe('awaiting_seal')
    })

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

    test('a Handoff that is not met, or has open items, is recorded but does not complete the Quest', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: l } = await s.claim(quest)
      const hash = await put(s)(lease.parse(l), 'x')
      const unmet = await callTool(s.transport, 'complete_quest', {
        lease: l,
        handoff: { ...handoffFor(hash), met: false },
      })
      expect(unmet).toMatchObject({ isError: true })
      expect(unmet.data.error).toBe('done_condition_unmet')
      expect((await s.quests.get(s.guild, quest.id))?.state).toBe('active')
      expect(await s.handoffs.get(s.guild, quest.id, 1)).not.toBeNull()
      const second = await s.post()
      const { lease: l2 } = await s.claim(second)
      const hash2 = await put(s)(lease.parse(l2), 'y')
      const open = await callTool(s.transport, 'complete_quest', {
        lease: l2,
        handoff: { ...handoffFor(hash2), openItems: ['verify the figures'] },
      })
      expect(open.data.error).toBe('done_condition_unmet')
      expect((await s.quests.get(s.guild, second.id))?.state).toBe('active')
    })

    test('a Handoff is final per attempt, and a new attempt may complete', async () => {
      const s = await setup()
      const quest = await s.post()
      const { lease: first } = await s.claim(quest)
      const hash = await put(s)(lease.parse(first), 'x')
      await callTool(s.transport, 'complete_quest', {
        lease: first,
        handoff: { ...handoffFor(hash), met: false },
      })
      const retry = await callTool(s.transport, 'complete_quest', {
        lease: first,
        handoff: handoffFor(hash),
      })
      expect(retry.data.error).toBe('handoff_conflict')
      expect(String(retry.data.message)).toContain('final per attempt')
      s.clock.advance(60 * 60 * 1000)
      const { lease: second } = await s.claim(quest)
      const hash2 = await put(s)(lease.parse(second), 'z')
      const done = await callTool(s.transport, 'complete_quest', {
        lease: second,
        handoff: handoffFor(hash2),
      })
      expect(done.isError).toBe(false)
      expect((await s.quests.get(s.guild, quest.id))?.state).toBe('done')
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
      const foreign = await s.notes.add(
        s.guild,
        {
          kind: 'text',
          title: '[heralds] Launch diagnosis',
          body: 'launch secrets',
          claim: 'assumption',
        },
        'health'
      )
      // The Guild Master's own note has no Hall and is visible to no Member.
      await s.notes.add(s.guild, {
        kind: 'text',
        title: 'Launch private',
        body: 'launch',
        claim: 'assumption',
      })
      const found = await callTool(s.transport, 'read_archive', { lease: l, query: 'launch' })
      const titles = z.array(z.object({ title: z.string() })).parse(found.data.notes)
      expect(titles.map((n) => n.title)).toEqual(['Launch plan'])
      const byId = await callTool(s.transport, 'read_archive', { lease: l, noteId: foreign.id })
      expect(byId).toMatchObject({ isError: true })
      expect(byId.data.error).toBe('not_found')
      const ghost = await callTool(s.transport, 'read_archive', {
        lease: l,
        noteId: crypto.randomUUID(),
      })
      expect(ghost.data).toEqual(byId.data)
    })

    test('list, search and id reads never show null-Hall or other-Hall notes', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post())
      const base = { kind: 'text', body: 'ledger', claim: 'assumption' } as const
      const mine = await s.notes.add(s.guild, { ...base, title: 'Mine' }, 'heralds')
      const rest = await s.notes.add(s.guild, { ...base, title: 'Rest-made' })
      const other = await s.notes.add(s.guild, { ...base, title: 'Other' }, 'health')
      for (const args of [{}, { query: 'ledger' }]) {
        const out = await callTool(s.transport, 'read_archive', { lease: l, ...args })
        const ids = z
          .array(z.object({ id: z.string() }))
          .parse(out.data.notes)
          .map((n) => n.id)
        expect(ids).toEqual([mine.id])
      }
      for (const hidden of [rest.id, other.id]) {
        const out = await callTool(s.transport, 'read_archive', { lease: l, noteId: hidden })
        expect(out.data.error).toBe('not_found')
      }
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

  describe('subagents', () => {
    const brief = 'Find three primary sources on the topic'
    const spawn = (t: Setup, l: unknown, over: Record<string, unknown> = {}) =>
      callTool(t.transport, 'spawn_subquest', {
        lease: l,
        title: 'Research',
        brief,
        template: 'herald-brief',
        ...over,
      })
    /** Applies a config edit the way the Guild Master would (confirming a widening one). */
    const configure = async (t: Setup, edit: (c: GuildConfig) => GuildConfig) => {
      const { config } = await t.deps.config.current(t.guild)
      const proposed = await t.deps.config.propose(t.guild, edit(config))
      if (proposed.status === 'pending') {
        await t.deps.config.confirm(t.guild, proposed.version)
      }
    }
    const childLease = async (t: Setup, id: string) => {
      const claimed = await t.quests.claim(t.guild, { leaseMs: 60_000, maxActive: 10, questId: id })
      if (!claimed) {
        throw new Error('expected the child claim')
      }
      return lease.parse(await t.gateway.lease(t.guild, claimed))
    }
    const parentOf = async (t: Setup, over: Partial<Parameters<Setup['post']>[0]> = {}) => {
      const { lease: l } = await t.claim(await t.post(over))
      return lease.parse(l)
    }
    const childId = (out: { data: Record<string, unknown> }) => z.string().parse(out.data.childId)

    test('spawns a Sub-Quest in the parent’s Hall that inherits its data class and starts at once', async () => {
      const s = await setup()
      const parent = await parentOf(s, { dataClass: 'private' })
      const out = await spawn(s, parent)
      expect(out).toMatchObject({ status: 200, isError: false, data: { depth: 1, created: true } })
      const child = await s.quests.get(s.guild, childId(out))
      expect(child).toMatchObject({
        title: 'Research',
        doneCondition: brief,
        hallId: 'heralds',
        ownerId: 'heralds-member-2',
        dataClass: 'private',
        campaignId: null,
        state: 'queued',
      })
      expect((await s.quests.children(s.guild, parent.questId))[0]).toMatchObject({
        childId: child?.id,
        dataClass: 'private',
      })
    })

    test('the children cap holds at its boundary, follows the config at once, and writes nothing over it', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      for (const n of [1, 2, 3]) {
        expect((await spawn(s, parent, { brief: `${brief} ${n}` })).isError).toBe(false)
      }
      const over = await spawn(s, parent, { brief: `${brief} 4` })
      expect(over).toMatchObject({ isError: true, data: { error: 'spawn_cap' } })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(4)
      await configure(s, (c) => ({ ...c, caps: { ...c.caps, maxChildrenPerQuest: 5 } }))
      expect((await spawn(s, parent, { brief: `${brief} 4` })).isError).toBe(false)
      await configure(s, (c) => ({ ...c, caps: { ...c.caps, maxChildrenPerQuest: 1 } }))
      expect(await spawn(s, parent, { brief: `${brief} 5` })).toMatchObject({
        data: { error: 'spawn_cap' },
      })
    })

    test('the depth cap lets a grandchild in and refuses its child', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      const kid = await childLease(s, childId(await spawn(s, parent)))
      const grand = await spawn(s, kid)
      expect(grand).toMatchObject({ isError: false, data: { depth: 2 } })
      const grandLease = await childLease(s, childId(grand))
      expect(await spawn(s, grandLease)).toMatchObject({
        isError: true,
        data: { error: 'depth_cap' },
      })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(3)
    })

    test('a resumed attempt that spawns the same brief again hits the cap and writes nothing', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      const kids = []
      for (const n of [1, 2, 3]) {
        kids.push(childId(await spawn(s, parent, { brief: `${brief} ${n}` })))
      }
      await callTool(s.transport, 'await_children', { lease: parent })
      for (const id of kids) {
        await new ScriptedMember(s.transport, { goal: 'ok', output: () => id }).runLeased(
          await childLease(s, id)
        )
      }
      const resumed = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 10 })
      expect(resumed?.attempts).toBe(2)
      const second = lease.parse(await s.gateway.lease(s.guild, resumed as Quest))
      // The key includes the attempt, so only the cap stops the repeat: a resumed Member reads child_results.
      expect(await spawn(s, second, { brief: `${brief} 1` })).toMatchObject({
        isError: true,
        data: { error: 'spawn_cap' },
      })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(4)
    })

    test('a retried spawn returns the same Sub-Quest and writes nothing more', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      const first = await spawn(s, parent)
      const again = await spawn(s, parent)
      expect(childId(again)).toBe(childId(first))
      expect(again.data.created).toBe(false)
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(2)
    })

    test('a Sub-Quest may go to another Hall only if it is unlocked, and into a private Hall only from private data', async () => {
      const s = await setup()
      await configure(s, (c) => ({
        ...c,
        halls: c.halls.map((h) =>
          h.id === 'health'
            ? {
                ...h,
                locked: false,
                privateEligible: true,
                members: [{ id: 'health-m', name: 'Healer', rank: 'journeyman' as const }],
              }
            : h
        ),
      }))
      const open = await parentOf(s, { dataClass: 'internal' })
      expect(await spawn(s, open, { hall: 'nowhere' })).toMatchObject({
        data: { error: 'hall_not_found' },
      })
      expect(await spawn(s, open, { hall: 'relationships' })).toMatchObject({
        data: { error: 'hall_locked' },
      })
      expect(await spawn(s, open, { hall: 'health' })).toMatchObject({
        isError: true,
        data: { error: 'private_hall' },
      })
      expect(await spawn(s, open, { template: 'unknown' })).toMatchObject({
        data: { error: 'unknown_template' },
      })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(1)
      const priv = await parentOf(s, { dataClass: 'private' })
      const allowed = await spawn(s, priv, { hall: 'health' })
      expect(allowed.isError).toBe(false)
      expect((await s.quests.get(s.guild, childId(allowed)))?.hallId).toBe('health')
    })

    test('await_children parks the parent until the children finish, then child_results returns each result', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      const a = childId(await spawn(s, parent, { brief: `${brief} A` }))
      const b = childId(await spawn(s, parent, { brief: `${brief} B` }))
      const waiting = await callTool(s.transport, 'await_children', { lease: parent })
      expect(waiting).toMatchObject({ isError: false, data: { waiting: true } })
      expect(await s.quests.get(s.guild, parent.questId)).toMatchObject({
        state: 'queued',
        leaseExpiresAt: null,
        waitingOn: [a, b],
      })
      // The slot is given up: the old lease opens nothing.
      expect((await callTool(s.transport, 'child_results', { lease: parent })).rpcError).toBe(
        'lease_expired'
      )
      for (const id of [a, b]) {
        const member = new ScriptedMember(s.transport, {
          goal: `Sources for ${id.slice(0, 4)}`,
          output: () => `Findings ${id}`,
        })
        await member.runLeased(await childLease(s, id))
      }
      const resumed = await s.quests.claim(s.guild, { leaseMs: 60_000, maxActive: 10 })
      expect(resumed).toMatchObject({ id: parent.questId, attempts: 2 })
      const again = lease.parse(await s.gateway.lease(s.guild, resumed as Quest))
      const results = await callTool(s.transport, 'child_results', { lease: again })
      const children = z
        .array(
          z.object({
            childId: z.string(),
            status: z.string(),
            result: z.object({ artifact: z.string().nullable(), summary: z.string() }).nullable(),
          })
        )
        .parse(results.data.children)
      expect(children.map((c) => [c.childId, c.status])).toEqual([
        [a, 'done'],
        [b, 'done'],
      ])
      expect(children[0]?.result?.summary).toBe(`Sources for ${a.slice(0, 4)}`)
      expect(children[0]?.result?.artifact).toMatch(/^[0-9a-f]{64}$/)
      // Everything is in: await_children returns at once and does not park.
      const done = await callTool(s.transport, 'await_children', { lease: again })
      expect(done).toMatchObject({ isError: false, data: { waiting: false } })
      expect((await s.quests.get(s.guild, parent.questId))?.state).toBe('active')
    })

    test('await_children any returns as soon as one child is done and reports the rest as pending', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      const a = childId(await spawn(s, parent, { brief: `${brief} A` }))
      const b = childId(await spawn(s, parent, { brief: `${brief} B` }))
      await new ScriptedMember(s.transport, { goal: 'A done', output: () => 'A' }).runLeased(
        await childLease(s, a)
      )
      const out = await callTool(s.transport, 'await_children', { lease: parent, mode: 'any' })
      expect(out).toMatchObject({ isError: false, data: { waiting: false } })
      const children = z
        .array(z.object({ childId: z.string(), status: z.string(), result: z.unknown() }))
        .parse(out.data.children)
      expect(children.map((c) => [c.childId, c.status, c.result === null])).toEqual([
        [a, 'done', false],
        [b, 'queued', true],
      ])
    })

    test('await_children with no Sub-Quests is refused, and an apprentice has none of the tools', async () => {
      const s = await setup()
      const parent = await parentOf(s)
      expect(await callTool(s.transport, 'await_children', { lease: parent })).toMatchObject({
        isError: true,
        data: { error: 'no_children' },
      })
      const { lease: low } = await s.claim(
        await s.post({ rank: 'apprentice', ownerId: 'heralds-member-1' })
      )
      expect((await spawn(s, low)).rpcError).toBe('unknown_tool')
    })

    test('a barred guild and a forged lease spawn nothing', async () => {
      const gates = new MemoryGateStore()
      const s = await setup({ gates })
      const parent = await parentOf(s)
      expect((await spawn(s, { ...parent, token: 'nope' })).rpcError).toBe('invalid_lease')
      await gates.bar({ guildId: s.guild, memberId: 'owner' }, 'guild')
      expect(await spawn(s, parent)).toMatchObject({ status: 401, rpcError: 'gates_barred' })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(1)
    })

    test('a Campaign started before the tools existed never sees them', async () => {
      const s = await setup()
      const old = new McpGateway({
        ...s.deps,
        catalog: TOOL_CATALOG.filter((t) => !SPAWN_TOOLS.includes(t.name)),
      })
      const quest = await s.post()
      const claimed = await callTool((r) => old.handle(r), 'claim_quest', {
        assignment: await old.assign(s.guild, quest),
      })
      expect((await spawn(s, claimed.data.lease)).rpcError).toBe('unknown_tool')
    })
  })

  describe('Hall teams', () => {
    const board = (t: Setup, l: unknown, over: Record<string, unknown> = {}) =>
      callTool(t.transport, 'post_to_board', {
        lease: l,
        title: 'Write the intro',
        brief: 'Draft the introduction',
        template: 'herald-brief',
        ...over,
      })
    const captainLease = async (t: Setup, over: Partial<Parameters<Setup['post']>[0]> = {}) => {
      const { lease: l } = await t.claim(
        await t.post({ ownerId: 'heralds-captain', campaignId: 'team-1', ...over })
      )
      return lease.parse(l)
    }

    test('the Captain posts into their own Hall under their Campaign; the Members then claim it', async () => {
      const s = await setup()
      const captain = await captainLease(s)
      const out = await board(s, captain, { blockedBy: [] })
      expect(out).toMatchObject({ status: 200, isError: false, data: { created: true } })
      const posted = await s.quests.get(s.guild, z.string().parse(out.data.questId))
      expect(posted).toMatchObject({
        title: 'Write the intro',
        doneCondition: 'Draft the introduction',
        hallId: 'heralds',
        campaignId: 'team-1',
        board: true,
        state: 'queued',
      })
      expect(['heralds-member-2', 'heralds-captain']).toContain(posted?.ownerId ?? '')
    })

    test('a Member is refused with captain_only and nothing is posted', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await s.post({ campaignId: 'team-1' }))
      expect(await board(s, l)).toMatchObject({ isError: true, data: { error: 'captain_only' } })
      expect((await s.quests.list(s.guild, { limit: 100 })).quests).toHaveLength(1)
    })

    test('a Captain whose Quest has no Campaign is refused with no_campaign', async () => {
      const s = await setup()
      const captain = await captainLease(s, { campaignId: undefined })
      expect(await board(s, captain)).toMatchObject({
        isError: true,
        data: { error: 'no_campaign' },
      })
    })

    test('the Campaign cap holds at its boundary and follows the config at once', async () => {
      const s = await setup()
      const captain = await captainLease(s)
      const { config } = await s.deps.config.current(s.guild)
      const capTo = async (n: number) => {
        const proposed = await s.deps.config.propose(s.guild, {
          ...config,
          caps: { ...config.caps, maxQuestsPerCampaign: n },
        })
        if (proposed.status === 'pending') {
          await s.deps.config.confirm(s.guild, proposed.version)
        }
      }
      await capTo(2)
      expect((await board(s, captain, { brief: 'one' })).isError).toBe(false)
      expect((await board(s, captain, { brief: 'two' })).isError).toBe(false)
      expect(await board(s, captain, { brief: 'three' })).toMatchObject({
        isError: true,
        data: { error: 'campaign_cap' },
      })
      await capTo(1)
      expect(await board(s, captain, { brief: 'four' })).toMatchObject({
        data: { error: 'campaign_cap' },
      })
    })

    test('a repeated post of the same Quest in one attempt returns it again', async () => {
      const s = await setup()
      const captain = await captainLease(s)
      const first = await board(s, captain)
      const again = await board(s, captain)
      expect(again.data).toMatchObject({ created: false, questId: first.data.questId })
    })

    test('the Hall and Campaign are not arguments: a Hall argument is refused', async () => {
      const s = await setup()
      const captain = await captainLease(s)
      expect(await board(s, captain, { hall: 'scribes' })).toMatchObject({
        rpcError: 'invalid_arguments',
      })
      expect(await board(s, captain, { template: 'no-such' })).toMatchObject({
        data: { error: 'unknown_template' },
      })
    })

    test('blockedBy must name Quests of the same Campaign', async () => {
      const s = await setup()
      const captain = await captainLease(s)
      const mine = await board(s, captain, { brief: 'first' })
      const stranger = await s.post({ campaignId: 'other-campaign' })
      const ok = await board(s, captain, {
        brief: 'second',
        blockedBy: [z.string().parse(mine.data.questId)],
      })
      expect(ok.isError).toBe(false)
      expect(await board(s, captain, { brief: 'third', blockedBy: [stranger.id] })).toMatchObject({
        isError: true,
        data: { error: 'unknown_blocker' },
      })
      expect(
        await board(s, captain, { brief: 'fourth', blockedBy: [crypto.randomUUID()] })
      ).toMatchObject({ isError: true, data: { error: 'unknown_blocker' } })
    })

    test('a lease from another guild opens nothing, and a Bar the Gates stops the Captain', async () => {
      const gates = new MemoryGateStore()
      const s = await setup({ gates })
      const captain = await captainLease(s)
      const other = await setup()
      expect(await board(other, captain)).toMatchObject({ status: 401 })
      await gates.bar({ guildId: s.guild, memberId: crypto.randomUUID() }, 'guild')
      expect(await board(s, captain)).toMatchObject({ status: 401, rpcError: 'gates_barred' })
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
