import { expect, test } from 'bun:test'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemorySealStore } from '../adapters/memory-seal-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { MemoryWorkflowStore } from '../adapters/memory-workflow-store'
import { defaultConfig } from '../guild-config'
import { ProposalEngine } from '../proposals'
import { WorkflowEngine } from './engine'
import type { WorkflowGraph } from './graph'
import { LEARNING_TO_LINKEDIN } from './templates'

async function setup() {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const config = new MemoryConfigStore(clock)
  const quests = new MemoryQuestQueue(clock, () => 0.5)
  const guild = crypto.randomUUID()
  await config.seed(guild)
  // A Tripwire store whose Hall pauses after `pauseAfter` checks, to fail a run part-way.
  const tripwires = Object.assign(Object.create(new MemoryTripwireStore(clock)), {
    pauseAfter: Number.POSITIVE_INFINITY,
    calls: 0,
    async isPaused(): Promise<boolean> {
      this.calls += 1
      return this.calls > this.pauseAfter
    },
  })
  const handoffs = new MemoryHandoffStore()
  const proposals = new ProposalEngine({ store: new MemoryProposalStore(clock), config })
  const engine = new WorkflowEngine({
    store: new MemoryWorkflowStore(clock),
    config,
    quests,
    tripwires,
    proposals,
    seals: new MemorySealStore(clock),
    handoffs,
  })
  return { engine, quests, config, guild, proposals, tripwires, handoffs }
}

/** Two agents in a row (a plain brief, then the sealed announcement), then the gate. */
const chain = (): WorkflowGraph => ({
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    {
      id: 'research',
      type: 'agent',
      hallId: 'heralds',
      templateId: 'herald-brief',
      briefTemplate: 'Collect what we learned',
      doneCondition: 'Notes are filed',
      maxUsd: 1,
    },
    {
      id: 'draft',
      type: 'agent',
      hallId: 'heralds',
      templateId: 'herald-announcement',
      briefTemplate: 'Draft from {{nodes.research.output}}',
      doneCondition: 'A post draft is ready for a Seal',
      maxUsd: 1,
    },
    { id: 'check', type: 'verify', of: 'draft' },
    { id: 'seal', type: 'approval', of: 'check' },
    { id: 'publish', type: 'post', of: 'seal' },
  ],
  edges: [
    { from: 'start', to: 'research' },
    { from: 'research', to: 'draft' },
    { from: 'draft', to: 'check' },
    { from: 'check', to: 'seal' },
    { from: 'seal', to: 'publish' },
  ],
})

const mustSave = async (
  engine: WorkflowEngine,
  guild: string,
  id: string,
  graph: unknown = chain()
) => {
  const saved = await engine.save(guild, id, { name: 'Chain', graph })
  if (saved.status === 'invalid') {
    throw new Error(`invalid: ${JSON.stringify(saved.errors)}`)
  }
  return saved
}

test('an invalid graph is refused with coded errors and nothing is stored', async () => {
  const { engine, guild } = await setup()
  const bad = chain()
  bad.edges = bad.edges.filter((e) => e.to !== 'seal')
  bad.edges.push({ from: 'check', to: 'publish' })
  const saved = await engine.save(guild, 'chain', { name: 'Chain', graph: bad })
  expect(saved.status).toBe('invalid')
  if (saved.status === 'invalid') {
    expect(saved.errors.map((e) => e.code)).toContain('gate_unapproved')
  }
  expect(await engine.run(guild, 'chain', {})).toMatchObject({ ok: false, error: 'not_found' })
  expect(await engine.validate(guild, bad)).not.toEqual([])
})

test('a first version that can post is widening: pending until confirmed; a brief edit is internal', async () => {
  const { engine, guild } = await setup()
  const first = await mustSave(engine, guild, 'chain')
  expect(first).toMatchObject({
    status: 'pending',
    version: { version: 1, classification: 'widening' },
  })
  expect(await engine.run(guild, 'chain', {})).toMatchObject({
    ok: false,
    error: 'no_active_version',
  })
  expect((await engine.confirm(guild, 'chain', 1))?.status).toBe('active')
  const edited = chain()
  const research = edited.nodes.find((n) => n.id === 'research')
  if (research?.type !== 'agent') {
    throw new Error('graph changed')
  }
  research.briefTemplate = 'A better brief'
  const second = await mustSave(engine, guild, 'chain', edited)
  expect(second).toMatchObject({
    status: 'active',
    version: { version: 2, classification: 'internal' },
  })
  expect(await engine.confirm(guild, 'chain', 9)).toBeNull()
})

test('a run pins a version and compiles agent nodes to Quests: blockedBy follows the edges, campaignId is the instance', async () => {
  const { engine, quests, guild } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const run = await engine.run(guild, 'chain', {})
  expect(run.ok).toBe(true)
  if (!run.ok) {
    return
  }
  expect(run.instance).toMatchObject({ workflowId: 'chain', version: 1 })
  expect(run.quests.map((q) => q.nodeId)).toEqual(['research', 'draft'])
  const [research, draft] = await Promise.all(run.quests.map((q) => quests.get(guild, q.questId)))
  expect(research).toMatchObject({
    campaignId: run.instance.id,
    templateId: 'herald-brief',
    blockedBy: [],
    jobKey: `${run.instance.id}:research:0`,
  })
  expect(draft).toMatchObject({
    campaignId: run.instance.id,
    templateId: 'herald-announcement',
    blockedBy: [research?.id],
    doneCondition: 'A post draft is ready for a Seal',
  })
})

test('a restart with the same run key makes no second instance and no second Quest', async () => {
  const { engine, quests, guild } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const first = await engine.run(guild, 'chain', { runKey: 'monday' })
  const again = await engine.run(guild, 'chain', { runKey: 'monday' })
  const other = await engine.run(guild, 'chain', { runKey: 'tuesday' })
  if (!(first.ok && again.ok && other.ok)) {
    throw new Error('runs should start')
  }
  expect(again.created).toBe(false)
  expect(again.instance.id).toBe(first.instance.id)
  expect(again.quests).toEqual(first.quests)
  expect(other.instance.id).not.toBe(first.instance.id)
  expect((await quests.list(guild, { limit: 100 })).quests).toHaveLength(4)
})

test('a run is refused when the config no longer allows it: the normal Quest checks apply', async () => {
  const { engine, config, guild } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const base = defaultConfig()
  await config.propose(guild, {
    ...base,
    halls: base.halls.map((h) => (h.id === 'heralds' ? { ...h, locked: true } : h)),
  })
  const run = await engine.run(guild, 'chain', {})
  expect(run).toMatchObject({ ok: false, error: 'invalid_workflow' })
})

test('an agent node whose Quest waits on its Sub-Quests reports awaiting_children, not queued', async () => {
  const { engine, guild, quests } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const run = await engine.run(guild, 'chain', {})
  if (!run.ok) {
    throw new Error('run should start')
  }
  const parent = run.quests.find((q) => q.nodeId === 'research')
  if (!parent) {
    throw new Error('no research Quest')
  }
  const held = await quests.claim(guild, {
    leaseMs: 60_000,
    maxActive: 10,
    questId: parent.questId,
  })
  if (!held) {
    throw new Error('expected a claim')
  }
  const { quest: child } = await quests.post(guild, {
    jobKey: `child-${crypto.randomUUID()}`,
    templateId: 'herald-brief',
    hallId: 'heralds',
    rank: 'journeyman',
    dataClass: 'internal',
    title: 'Sub-Quest',
    ownerId: held.ownerId,
    doneCondition: 'done',
    roundLimit: 2,
  })
  await quests.park(guild, held.id, held.attempts, [child.id], 'all')
  const state = await engine.state(guild, run.instance.id)
  expect(state?.nodes.find((n) => n.id === 'research')?.status).toBe('awaiting_children')
})

test('run state reports each node: agents from their Quest, the gate from the Verdict and Seal', async () => {
  const { engine, guild, quests } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const run = await engine.run(guild, 'chain', {})
  if (!run.ok) {
    throw new Error('run should start')
  }
  const state = await engine.state(guild, run.instance.id)
  expect(state?.nodes.map((n) => [n.id, n.status])).toEqual([
    ['start', 'done'],
    ['research', 'queued'],
    ['draft', 'queued'],
    ['check', 'pending'],
    ['seal', 'pending'],
    ['publish', 'pending'],
  ])
  expect(await engine.state(guild, crypto.randomUUID())).toBeNull()
  expect((await quests.list(guild, { limit: 10 })).quests).toHaveLength(2)
})

test('the seeded template is saved once, active, and runs', async () => {
  const { engine, guild } = await setup()
  await engine.seedTemplates(guild)
  await engine.seedTemplates(guild)
  const run = await engine.run(guild, 'learning-to-linkedin', {})
  expect(run).toMatchObject({ ok: true })
  expect(await engine.validate(guild, LEARNING_TO_LINKEDIN)).toEqual([])
})

test('a pending widening version is not a baseline: an equal follow-up save stays pending and cannot run', async () => {
  const { engine, guild } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  const wider = chain()
  const research = wider.nodes.find((n) => n.id === 'research')
  if (research?.type !== 'agent') {
    throw new Error('graph changed')
  }
  research.maxUsd = 2
  const v2 = await mustSave(engine, guild, 'chain', wider)
  const v3 = await mustSave(engine, guild, 'chain', wider)
  expect(v2).toMatchObject({ status: 'pending', version: { version: 2 } })
  expect(v3).toMatchObject({
    status: 'pending',
    version: { version: 3, classification: 'widening' },
  })
  expect(await engine.run(guild, 'chain', { version: 3 })).toMatchObject({
    ok: false,
    error: 'version_not_active',
  })
  expect(await engine.run(guild, 'chain', {})).toMatchObject({ ok: true, instance: { version: 1 } })
})

test('a retry after a failed post resumes the same run and posts only the missing Quest', async () => {
  const { engine, quests, guild, tripwires } = await setup()
  await mustSave(engine, guild, 'chain')
  await engine.confirm(guild, 'chain', 1)
  tripwires.pauseAfter = 1
  const failed = await engine.run(guild, 'chain', {})
  expect(failed).toMatchObject({ ok: false, error: 'hall_paused', nodeId: 'draft' })
  if (failed.ok) {
    return
  }
  expect(typeof failed.runKey).toBe('string')
  expect((await quests.list(guild, { limit: 10 })).quests).toHaveLength(1)
  tripwires.pauseAfter = Number.POSITIVE_INFINITY
  const retry = await engine.run(guild, 'chain', { runKey: failed.runKey ?? 'missing' })
  expect(retry).toMatchObject({ ok: true, created: false })
  expect((await quests.list(guild, { limit: 10 })).quests).toHaveLength(2)
})

test('two concurrent seeds leave exactly one version', async () => {
  const { engine, guild } = await setup()
  await Promise.all([engine.seedTemplates(guild), engine.seedTemplates(guild)])
  expect((await engine.get(guild, 'learning-to-linkedin'))?.version.version).toBe(1)
})

const handoffOf = (artifact: string) => ({
  goal: 'Finished',
  doneCondition: 'Done',
  met: true,
  evidence: [],
  openItems: [],
  artifacts: [artifact],
})

const fanOut = (join: 'all' | 'any' = 'all'): WorkflowGraph => ({
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    {
      id: 'fan',
      type: 'subagents',
      hallId: 'heralds',
      templateId: 'herald-brief',
      briefs: ['Research topic A', 'Research topic B'],
      join,
      maxUsd: 1,
    },
  ],
  edges: [{ from: 'start', to: 'fan' }],
})

const crew: WorkflowGraph = {
  nodes: [
    { id: 'start', type: 'trigger.manual' },
    {
      id: 'crew',
      type: 'team',
      hallId: 'heralds',
      goal: 'Ship the launch notes',
      maxMembers: 2,
      maxQuests: 3,
      maxUsd: 1,
    },
  ],
  edges: [{ from: 'start', to: 'crew' }],
}

const status = async (engine: WorkflowEngine, guild: string, instance: string, node: string) =>
  (await engine.state(guild, instance))?.nodes.find((n) => n.id === node)

test('a subagents node posts one coordinating Quest naming its briefs, and reaches done with the children`s result refs', async () => {
  const { engine, quests, guild, handoffs } = await setup()
  await mustSave(engine, guild, 'fan', fanOut())
  await engine.confirm(guild, 'fan', 1)
  const run = await engine.run(guild, 'fan', { runKey: 'k' })
  if (!run.ok) {
    throw new Error(`run refused: ${run.error}`)
  }
  expect(await engine.run(guild, 'fan', { runKey: 'k' })).toMatchObject({ created: false })
  const all = (await quests.list(guild, { limit: 10 })).quests
  expect(all).toHaveLength(1)
  const parent = all[0]
  expect(parent).toMatchObject({ templateId: 'herald-brief', campaignId: run.instance.id })
  expect(parent?.doneCondition).toContain('Research topic A')
  expect(parent?.doneCondition).toContain('await_children')
  expect(await status(engine, guild, run.instance.id, 'fan')).toMatchObject({
    status: 'queued',
    questId: parent?.id,
    refs: [],
  })

  const claimed = await quests.claim(guild, { leaseMs: 60_000, maxActive: 4 })
  if (!claimed) {
    throw new Error('nothing to claim')
  }
  const kids = []
  for (const [i, brief] of ['A', 'B'].entries()) {
    const spawned = await quests.spawn(guild, {
      parentId: claimed.id,
      attempt: claimed.attempts,
      briefHash: `h${i}`,
      child: {
        templateId: 'herald-brief',
        hallId: 'heralds',
        rank: 'journeyman',
        dataClass: 'internal',
        title: `Topic ${brief}`,
        ownerId: 'heralds-member-2',
        doneCondition: `Research ${brief}`,
        roundLimit: 2,
      },
      maxChildren: 3,
      maxDepth: 2,
    })
    if (!spawned.ok) {
      throw new Error('spawn refused')
    }
    kids.push(spawned.quest)
  }
  await quests.park(
    guild,
    claimed.id,
    claimed.attempts,
    kids.map((k) => k.id),
    'all'
  )
  expect((await status(engine, guild, run.instance.id, 'fan'))?.status).toBe('awaiting_children')
  for (const [i, kid] of kids.entries()) {
    const c = await quests.claim(guild, { leaseMs: 60_000, maxActive: 4, questId: kid.id })
    if (!c) {
      throw new Error('child not claimable')
    }
    await handoffs.record(
      guild,
      kid.id,
      c.attempts,
      'heralds-member-2',
      handoffOf(String(i).repeat(64))
    )
    await quests.complete(guild, kid.id, c.attempts)
  }
  const resumed = await quests.claim(guild, { leaseMs: 60_000, maxActive: 4, questId: claimed.id })
  if (!resumed) {
    throw new Error('parent not resumed')
  }
  expect((await status(engine, guild, run.instance.id, 'fan'))?.status).toBe('running')
  await quests.complete(guild, claimed.id, resumed.attempts)
  expect(await status(engine, guild, run.instance.id, 'fan')).toMatchObject({
    status: 'done',
    refs: ['0'.repeat(64), '1'.repeat(64)],
  })
})

test('a team node starts a Captain-led Campaign and reaches done with the board Quests` result refs', async () => {
  const { engine, quests, guild, handoffs } = await setup()
  await mustSave(engine, guild, 'crew', crew)
  await engine.confirm(guild, 'crew', 1)
  const run = await engine.run(guild, 'crew', { runKey: 'k' })
  if (!run.ok) {
    throw new Error(`run refused: ${run.error}`)
  }
  expect(await engine.run(guild, 'crew', { runKey: 'k' })).toMatchObject({ created: false })
  const plan = (await quests.list(guild, { limit: 10 })).quests
  expect(plan).toHaveLength(1)
  expect(plan[0]).toMatchObject({ templateId: 'team-plan', ownerId: 'heralds-captain' })
  expect(plan[0]?.title).toContain('Ship the launch notes')
  const campaignId = plan[0]?.campaignId ?? ''
  expect(campaignId.startsWith(run.instance.id)).toBe(true)
  expect(await status(engine, guild, run.instance.id, 'crew')).toMatchObject({
    status: 'queued',
    refs: [],
  })

  const captain = await quests.claim(guild, { leaseMs: 60_000, maxActive: 4 })
  if (!captain) {
    throw new Error('captain not claimed')
  }
  const board = []
  for (const n of [1, 2]) {
    const posted = await quests.postBoard(guild, {
      parentId: captain.id,
      attempt: captain.attempts,
      jobKey: `board:${n}`,
      campaignId,
      quest: {
        templateId: 'herald-brief',
        hallId: 'heralds',
        rank: 'journeyman',
        dataClass: 'internal',
        title: `Section ${n}`,
        ownerId: 'heralds-member-2',
        doneCondition: `Write ${n}`,
        roundLimit: 2,
        blockedBy: [],
      },
      maxQuests: 3,
    })
    if (!posted.ok) {
      throw new Error('board refused')
    }
    board.push(posted.quest)
  }
  await quests.complete(guild, captain.id, captain.attempts)
  expect((await status(engine, guild, run.instance.id, 'crew'))?.status).toBe('running')
  for (const [i, q] of board.entries()) {
    const c = await quests.claim(guild, { leaseMs: 60_000, maxActive: 4, questId: q.id })
    if (!c) {
      throw new Error('board Quest not claimable')
    }
    await handoffs.record(
      guild,
      q.id,
      c.attempts,
      'heralds-member-2',
      handoffOf(String(i + 5).repeat(64))
    )
    await quests.complete(guild, q.id, c.attempts)
    if (i === 0) {
      expect((await status(engine, guild, run.instance.id, 'crew'))?.status).toBe('running')
    }
  }
  expect(await status(engine, guild, run.instance.id, 'crew')).toMatchObject({
    status: 'done',
    refs: ['5'.repeat(64), '6'.repeat(64)],
  })
})

test('a fan-out node is widening: a new one, or a changed brief list, waits for confirmation', async () => {
  const { engine, guild } = await setup()
  expect(await mustSave(engine, guild, 'fan', fanOut())).toMatchObject({ status: 'pending' })
  await engine.confirm(guild, 'fan', 1)
  const edited = fanOut()
  const node = edited.nodes.find((n) => n.id === 'fan')
  if (node?.type !== 'subagents') {
    throw new Error('graph changed')
  }
  node.briefs = ['Research something else']
  expect(await mustSave(engine, guild, 'fan', edited)).toMatchObject({ status: 'pending' })
})
