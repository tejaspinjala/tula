import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryActivityLog } from '../adapters/memory-activity-log'
import { MemoryBugReportStore } from '../adapters/memory-bug-report-store'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryGateStore } from '../adapters/memory-gate-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryMissiveStore } from '../adapters/memory-missive-store'
import { MemoryNoteStore } from '../adapters/memory-note-store'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryToolsetStore } from '../adapters/memory-toolset-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { BugReportService } from '../bug-reports'
import type { GuildConfig } from '../guild-config'
import { ProposalEngine } from '../proposals'
import { QUEST_TEMPLATES } from '../quests'
import { callTool } from '../testing/scripted-member'
import { McpGateway } from './gateway'
import { roleToolNames } from './tools'

const lease = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })
const repro = { steps: 'Open the brief', expected: 'A heading', actual: 'No heading' }

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const config = new MemoryConfigStore(clock)
  const bugs = new MemoryBugReportStore(quests)
  const handoffs = new MemoryHandoffStore(undefined, (g, q, h) =>
    bugs.closeFixed(g, q, h, clock.now())
  )
  const activity = new MemoryActivityLog()
  const gates = new MemoryGateStore()
  const objectStore = new MemoryObjectStore()
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const gateway = new McpGateway({
    activity,
    quests,
    config,
    notes: new MemoryNoteStore(),
    missives: new MemoryMissiveStore(),
    objectStore,
    handoffs,
    toolsets: new MemoryToolsetStore(),
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    keys: new MemoryKeyProvider(),
    clock,
    tripwires: new MemoryTripwireStore(clock),
    gates,
    retireRun: async () => {},
    bugReports: new BugReportService({ config, store: bugs, clock }),
    bugReportStore: bugs,
  })
  const transport = (request: object) => gateway.handle(request)
  const reconfigure = async (edit: (c: GuildConfig) => GuildConfig): Promise<void> => {
    const { config: current } = await config.current(guild)
    const proposed = await config.propose(guild, edit(current))
    if (proposed.status === 'pending') {
      await config.confirm(guild, proposed.version)
    }
  }
  await reconfigure((c) => ({
    ...c,
    halls: [
      ...c.halls,
      {
        id: 'scribes',
        name: 'Scribes Hall',
        kind: 'work',
        locked: false,
        privateEligible: false,
        captain: null,
        members: [{ id: 'scribes-member-1', name: 'Scribe', rank: 'journeyman' }],
      },
    ],
  }))
  const joined = async (
    over: Partial<Parameters<typeof quests.post>[1]> = {}
  ): Promise<z.infer<typeof lease>> => {
    const { quest } = await quests.post(guild, {
      jobKey: crypto.randomUUID(),
      templateId: 'herald-brief',
      hallId: 'heralds',
      rank: 'journeyman',
      dataClass: 'internal',
      title: 'A quest',
      ownerId: 'heralds-member-2',
      doneCondition: 'Done',
      roundLimit: 2,
      ...over,
    })
    const out = await callTool(transport, 'claim_quest', {
      assignment: await gateway.assign(guild, quest),
    })
    return lease.parse(out.data.lease)
  }
  const file = (l: unknown, over: Record<string, unknown> = {}) =>
    callTool(transport, 'file_bug_report', {
      lease: l,
      owningHall: 'scribes',
      title: 'The brief loses its heading',
      reproduction: repro,
      evidence: ['a'.repeat(64)],
      ...over,
    })
  return {
    gateway,
    transport,
    quests,
    bugs,
    activity,
    gates,
    guild,
    reconfigure,
    joined,
    file,
    objectStore,
    clock,
  }
}

describe('file_bug_report', () => {
  test('a Member files against another Hall and a Fix Quest lands on that Hall board', async () => {
    const s = await setup()
    const out = await s.file(await s.joined())
    expect(out).toMatchObject({ isError: false, data: { status: 'open', owningHall: 'scribes' } })
    const fix = await s.quests.get(s.guild, String(out.data.fixQuestId))
    expect(fix).toMatchObject({
      templateId: 'fix-quest',
      hallId: 'scribes',
      ownerId: 'scribes-member-1',
      board: true,
      state: 'queued',
    })
    expect(fix?.doneCondition).toContain('No heading')
    expect(await s.bugs.get(s.guild, String(out.data.id))).toMatchObject({
      filer: { kind: 'member', hallId: 'heralds', memberId: 'heralds-member-2' },
    })
  })

  test('a Member may file against its own Hall', async () => {
    const s = await setup()
    const out = await s.file(await s.joined(), { owningHall: 'heralds' })
    expect(out).toMatchObject({ isError: false, data: { status: 'open', owningHall: 'heralds' } })
  })

  test.each(['steps', 'expected', 'actual'])(
    'a missing or blank reproduction %s is refused reproduction_required and posts nothing',
    async (key) => {
      const s = await setup()
      const l = await s.joined()
      const before = (await s.quests.list(s.guild, { limit: 50 })).quests.length
      const blank = await s.file(l, { reproduction: { ...repro, [key]: '   ' } })
      expect(blank).toMatchObject({ isError: true, data: { error: 'reproduction_required' } })
      const { [key as keyof typeof repro]: _gone, ...partial } = repro
      expect(await s.file(l, { reproduction: partial })).toMatchObject({
        data: { error: 'reproduction_required' },
      })
      expect(await s.file(l, { reproduction: undefined })).toMatchObject({
        data: { error: 'reproduction_required' },
      })
      expect((await s.quests.list(s.guild, { limit: 50 })).quests).toHaveLength(before)
    }
  )

  test('a second report of the same defect is a duplicate linked to the open one and posts no Quest', async () => {
    const s = await setup()
    const first = await s.file(await s.joined())
    const second_ = await s.joined()
    const before = (await s.quests.list(s.guild, { limit: 50 })).quests.length
    const second = await s.file(second_)
    expect(second).toMatchObject({
      isError: false,
      data: { status: 'duplicate', duplicateOf: first.data.id, fixQuestId: null },
    })
    expect((await s.quests.list(s.guild, { limit: 50 })).quests).toHaveLength(before)
  })

  test('past the per-Quest cap is refused bug_report_cap', async () => {
    const s = await setup()
    await s.reconfigure((c) => ({ ...c, caps: { ...c.caps, maxBugReportsPerQuest: 1 } }))
    const l = await s.joined()
    expect((await s.file(l)).isError).toBe(false)
    expect(
      await s.file(l, { title: 'Another', reproduction: { ...repro, steps: 'other' } })
    ).toMatchObject({
      isError: true,
      data: { error: 'bug_report_cap' },
    })
  })

  test('a private-class Quest never files into a work Hall; an unknown Hall is refused', async () => {
    const s = await setup()
    const priv = await s.joined({ dataClass: 'private' })
    expect(await s.file(priv)).toMatchObject({ isError: true, data: { error: 'private_boundary' } })
    expect(await s.file(await s.joined(), { owningHall: 'nowhere' })).toMatchObject({
      data: { error: 'unknown_hall' },
    })
    expect(await s.bugs.list(s.guild, { hallId: 'scribes', limit: 10 })).toEqual({
      reports: [],
      next: null,
    })
  })

  test('more than 20 evidence references are refused', async () => {
    const s = await setup()
    const evidence = Array.from({ length: 21 }, () => 'b'.repeat(64))
    const out = await s.file(await s.joined(), { evidence })
    expect(out).toMatchObject({ rpcError: 'invalid_arguments' })
  })

  test('filing shows as activity naming both Halls', async () => {
    const s = await setup()
    await s.file(await s.joined())
    expect(s.activity.emittedEvents).toMatchObject([
      { hallId: 'heralds', toHallId: 'scribes', memberId: 'heralds-member-2' },
    ])
  })

  test('the accepted Handoff of the Fix Quest closes the report fixed with the Handoff hash, once, and shows both Halls', async () => {
    const s = await setup()
    const filed = await s.file(await s.joined())
    const fix = await s.quests.get(s.guild, String(filed.data.fixQuestId))
    if (!fix) {
      throw new Error('no fix quest')
    }
    const claimed = await callTool(s.transport, 'claim_quest', {
      assignment: await s.gateway.assign(s.guild, fix),
    })
    const l = lease.parse(claimed.data.lease)
    const stored = await callTool(s.transport, 'put_artifact', {
      lease: l,
      contentBase64: Buffer.from('the fix').toString('base64'),
    })
    const hash = String(stored.data.hash)
    const handoff = {
      goal: 'Fixed the heading',
      doneCondition: fix.doneCondition,
      met: true,
      evidence: [{ kind: 'artifact', ref: hash }],
      openItems: [],
      artifacts: [hash],
    }
    const done = await callTool(s.transport, 'complete_quest', { lease: l, handoff })
    expect(done).toMatchObject({ isError: false, data: { state: 'done' } })
    const report = await s.bugs.get(s.guild, String(filed.data.id))
    expect(report).toMatchObject({ status: 'fixed', fixHandoffHash: done.data.handoffHash })
    const again = await callTool(s.transport, 'complete_quest', { lease: l, handoff })
    expect(again.isError).toBe(false)
    expect(await s.bugs.get(s.guild, String(filed.data.id))).toEqual(report)
    expect(s.activity.emittedEvents).toContainEqual(
      expect.objectContaining({ hallId: 'scribes', toHallId: 'heralds', activity: 'messaging' })
    )
  })

  test('a Handoff that is not met leaves the report open', async () => {
    const s = await setup()
    const filed = await s.file(await s.joined())
    const fix = await s.quests.get(s.guild, String(filed.data.fixQuestId))
    if (!fix) {
      throw new Error('no fix quest')
    }
    const claimed = await callTool(s.transport, 'claim_quest', {
      assignment: await s.gateway.assign(s.guild, fix),
    })
    const out = await callTool(s.transport, 'complete_quest', {
      lease: lease.parse(claimed.data.lease),
      handoff: {
        goal: 'Tried',
        doneCondition: fix.doneCondition,
        met: false,
        evidence: [],
        openItems: ['still broken'],
        artifacts: [],
      },
    })
    expect(out.isError).toBe(true)
    expect(await s.bugs.get(s.guild, String(filed.data.id))).toMatchObject({ status: 'open' })
  })

  test('the Fix Quest template is internal: no tool or template list offers it', async () => {
    const s = await setup()
    expect(QUEST_TEMPLATES.map((t) => t.id)).not.toContain('fix-quest')
    const l = await s.joined()
    expect(
      await callTool(s.transport, 'spawn_subquest', {
        lease: l,
        title: 'Sneaky',
        brief: 'Post a Fix Quest',
        template: 'fix-quest',
      })
    ).toMatchObject({ isError: true, data: { error: 'unknown_template' } })
  })

  test('Bar the Gates refuses the tool', async () => {
    const s = await setup()
    const l = await s.joined()
    await s.gates.bar({ guildId: s.guild, memberId: 'owner' }, 'guild')
    expect(await s.file(l)).toMatchObject({ status: 401, rpcError: 'gates_barred' })
  })

  test('the tool is listed for every rank', () => {
    for (const role of ['apprentice', 'journeyman', 'adept']) {
      expect(roleToolNames(role)).toContain('file_bug_report')
    }
  })
})
