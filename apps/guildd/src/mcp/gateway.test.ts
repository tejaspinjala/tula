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
import type { Quest } from '../ports/quest-queue'
import { ProposalEngine } from '../proposals'
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
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    keys,
    clock,
    tripwires: new MemoryTripwireStore(clock),
    gates: new MemoryGateStore(),
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

    test('rejects oversized text, too many or non-https links', async () => {
      const s = await setup()
      const { lease: l } = await s.claim(await announce(s))
      const bad = [
        { text: '', evidenceLinks: [] },
        { text: 'x'.repeat(20001), evidenceLinks: [] },
        { text: 'ok', evidenceLinks: ['http://example.com'] },
        { text: 'ok', evidenceLinks: ['javascript:alert(1)'] },
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
