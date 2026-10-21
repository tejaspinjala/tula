import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { MemoryActivityLog } from '../adapters/memory-activity-log'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryGateStore } from '../adapters/memory-gate-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryInquiryStore } from '../adapters/memory-inquiry-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryMissiveStore } from '../adapters/memory-missive-store'
import { MemoryNoteStore } from '../adapters/memory-note-store'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryToolsetStore } from '../adapters/memory-toolset-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import type { GuildConfig } from '../guild-config'
import type { DataClass, Quest } from '../ports/quest-queue'
import { ProposalEngine } from '../proposals'
import { gatewayExtras } from '../testing/gateway-extras'
import { callTool } from '../testing/scripted-member'
import { McpGateway } from './gateway'

const lease = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const config = new MemoryConfigStore(clock)
  const notes = new MemoryNoteStore()
  const inquiries = new MemoryInquiryStore(quests)
  const activity = new MemoryActivityLog()
  const gates = new MemoryGateStore()
  const guild = crypto.randomUUID()
  await config.seed(guild)
  const { config: current } = await config.current(guild)
  const proposed = await config.propose(guild, withHalls(current))
  if (proposed.status === 'pending') {
    await config.confirm(guild, proposed.version)
  }
  const objectStore = new MemoryObjectStore()
  const handoffs = new MemoryHandoffStore()
  const proposalStore = new MemoryProposalStore(clock)
  const tripwires = new MemoryTripwireStore(clock)
  const gateway = new McpGateway({
    activity,
    quests,
    config,
    notes,
    missives: new MemoryMissiveStore(),
    inquiries,
    objectStore,
    handoffs,
    toolsets: new MemoryToolsetStore(),
    proposals: new ProposalEngine({ store: proposalStore, config }),
    ...gatewayExtras({
      quests,
      config,
      handoffs,
      objectStore,
      proposals: proposalStore,
      tripwires,
      clock,
    }),
    keys: new MemoryKeyProvider(),
    clock,
    tripwires,
    gates,
    retireRun: async () => {},
  })
  const transport = (request: object) => gateway.handle(request)
  /** Posts a Quest and returns its lease handle, claimed through the gateway. */
  const joined = async (
    hallId: string,
    ownerId: string,
    over: { rank?: Quest['rank']; dataClass?: DataClass } = {}
  ) => {
    const { quest } = await quests.post(guild, {
      jobKey: crypto.randomUUID(),
      templateId: 'herald-brief',
      hallId,
      rank: over.rank ?? 'journeyman',
      dataClass: over.dataClass ?? 'internal',
      title: 'Work',
      ownerId,
      doneCondition: 'Do the work',
      roundLimit: 2,
    })
    const out = await callTool(transport, 'claim_quest', {
      assignment: await gateway.assign(guild, quest),
    })
    return { quest, lease: lease.parse(out.data.lease) }
  }
  /** The answer Quest an ask posted, claimed through the gateway as its owner. */
  const claimAnswerQuest = async (questId: string) => {
    const quest = await quests.get(guild, questId)
    if (!quest) {
      throw new Error('no answer quest')
    }
    const out = await callTool(transport, 'claim_quest', {
      assignment: await gateway.assign(guild, quest),
    })
    return { quest, lease: lease.parse(out.data.lease) }
  }
  const ask = (l: unknown, toHall: string, question: string) =>
    callTool(transport, 'ask_hall', { lease: l, toHall, question })
  return {
    gateway,
    transport,
    clock,
    quests,
    notes,
    inquiries,
    activity,
    gates,
    guild,
    config,
    joined,
    claimAnswerQuest,
    ask,
  }
}

function withHalls(c: GuildConfig): GuildConfig {
  return {
    ...c,
    halls: [
      ...c.halls,
      {
        id: 'scribes',
        name: 'Scribes Hall',
        kind: 'work',
        locked: false,
        privateEligible: false,
        captain: { id: 'scribes-captain', name: 'Scribe Captain' },
        members: [{ id: 'scribes-member-1', name: 'Scribe', rank: 'journeyman' }],
      },
      {
        id: 'vault',
        name: 'Vault Hall',
        kind: 'private',
        locked: false,
        privateEligible: false,
        captain: { id: 'vault-captain', name: 'Vault Keeper' },
        members: [],
      },
    ],
  }
}

type Setup = Awaited<ReturnType<typeof setup>>

const SECRET = 'the-private-diary-entry-xyzzy'

/** A private-class Quest in the Scribes Hall writes a note; returns that note's id. */
async function privateNote(s: Setup): Promise<string> {
  const writer = await s.joined('scribes', 'scribes-member-1', { dataClass: 'private' })
  const out = await callTool(s.transport, 'write_archive', {
    lease: writer.lease,
    title: 'Diary',
    body: SECRET,
    claim: 'assumption',
  })
  return String(out.data.id)
}

describe('private notes never leave their Hall through any read path', () => {
  test('a note written by a private Quest is stored private', async () => {
    const s = await setup()
    const id = await privateNote(s)
    const detail = await s.notes.get(s.guild, id, 'scribes', { includePrivate: true })
    expect(detail?.note.dataClass).toBe('private')
  })

  test('read_archive by id, by list and by search omits it for a work-Hall Member', async () => {
    const s = await setup()
    const id = await privateNote(s)
    const reader = await s.joined('scribes', 'scribes-member-1')
    const byId = await callTool(s.transport, 'read_archive', { lease: reader.lease, noteId: id })
    expect(byId).toMatchObject({ isError: true, data: { error: 'not_found' } })
    const listed = await callTool(s.transport, 'read_archive', { lease: reader.lease })
    const found = await callTool(s.transport, 'read_archive', {
      lease: reader.lease,
      query: 'xyzzy',
    })
    for (const out of [byId, listed, found]) {
      expect(JSON.stringify(out)).not.toContain(SECRET)
      expect(JSON.stringify(out)).not.toContain('Diary')
    }
    expect(found.data.notes).toEqual([])
  })

  test('the private Quest itself still reads its own note', async () => {
    const s = await setup()
    const id = await privateNote(s)
    const owner = await s.joined('scribes', 'scribes-member-1', { dataClass: 'private' })
    const out = await callTool(s.transport, 'read_archive', { lease: owner.lease, noteId: id })
    expect(out).toMatchObject({ isError: false, data: { note: { body: SECRET } } })
  })

  test('the Brief of a work-Hall Quest does not point at it', async () => {
    const s = await setup()
    await privateNote(s)
    const reader = await s.joined('scribes', 'scribes-member-1')
    const brief = await callTool(s.transport, 'read_brief', { lease: reader.lease })
    expect(brief.isError).toBe(false)
    expect(JSON.stringify(brief)).not.toContain('Diary')
  })

  test('an Inquiry answered in a private Hall files a private note a work-Hall Member cannot read', async () => {
    const s = await setup()
    const asker = await s.joined('heralds', 'heralds-member-2', { dataClass: 'private' })
    const asked = await s.ask(asker.lease, 'vault', 'Which tone?')
    const inquiryId = String(asked.data.inquiryId)
    const answerer = await s.claimAnswerQuest(String(asked.data.answerQuestId))
    await callTool(s.transport, 'answer_inquiry', {
      lease: answerer.lease,
      inquiryId,
      answer: SECRET,
    })
    const reader = await s.joined('heralds', 'heralds-member-2')
    const listed = await callTool(s.transport, 'read_archive', { lease: reader.lease })
    expect(JSON.stringify(listed)).not.toContain(SECRET)
    expect(listed.data.notes).toEqual([])
    const filed = await s.notes.list(s.guild, { limit: 10, hall: 'vault', includePrivate: true })
    expect(filed.notes.map((n) => n.dataClass)).toEqual(['private'])
    const inquiry = await callTool(s.transport, 'read_inquiry', { lease: reader.lease, inquiryId })
    expect(inquiry).toMatchObject({ isError: true, data: { error: 'not_found' } })
  })

  test('a Dossier about a private Quest is refused to a work-Hall Member', async () => {
    const s = await setup()
    const subject = (
      await s.quests.post(s.guild, {
        jobKey: crypto.randomUUID(),
        templateId: 'herald-brief',
        hallId: 'scribes',
        rank: 'journeyman',
        dataClass: 'private',
        title: 'Diary',
        ownerId: 'scribes-member-1',
        doneCondition: 'Done',
        roundLimit: 2,
      })
    ).quest
    const reader = await s.joined('heralds', 'heralds-member-2')
    const out = await callTool(s.transport, 'request_dossier', {
      lease: reader.lease,
      questId: subject.id,
    })
    expect(out).toMatchObject({ isError: true, data: { error: 'private_boundary' } })
  })

  test('a Bug Report from a private Quest into a work Hall is refused', async () => {
    const s = await setup()
    const filer = await s.joined('heralds', 'heralds-member-2', { dataClass: 'private' })
    const out = await callTool(s.transport, 'file_bug_report', {
      lease: filer.lease,
      owningHall: 'scribes',
      title: 'Broken',
      reproduction: { steps: SECRET, expected: 'a', actual: 'b' },
      evidence: ['a'.repeat(64)],
    })
    expect(out).toMatchObject({ isError: true, data: { error: 'private_boundary' } })
    expect(JSON.stringify(out)).not.toContain(SECRET)
  })
})
