import { describe, expect, test } from 'bun:test'
import { defaultConfig, type GuildConfig } from '../guild-config'
import type { WorkflowGraph } from './graph'
import { LEARNING_TO_LINKEDIN } from './templates'
import { validateWorkflow } from './validate'

const config = (over: Partial<GuildConfig> = {}): GuildConfig => ({ ...defaultConfig(), ...over })
const clone = (): WorkflowGraph => structuredClone(LEARNING_TO_LINKEDIN)
const codes = (graph: unknown, c: GuildConfig = config()) =>
  validateWorkflow(graph, c).map((e) => (e.nodeId ? `${e.code}:${e.nodeId}` : e.code))

describe('validateWorkflow', () => {
  test('the seeded template is valid', () => {
    expect(validateWorkflow(LEARNING_TO_LINKEDIN, config())).toEqual([])
  })

  test('schema errors are coded', () => {
    expect(codes({ nodes: [{ id: 'x', type: 'bogus' }], edges: [] })).toEqual(['schema_invalid'])
    expect(codes('nope')).toEqual(['schema_invalid'])
  })

  test('graph: needs a trigger, unique ids, known edge ends and no trigger input', () => {
    const noTrigger = clone()
    noTrigger.nodes = noTrigger.nodes.filter((n) => n.type !== 'trigger.manual')
    noTrigger.edges = noTrigger.edges.filter((e) => e.from !== 'start')
    expect(codes(noTrigger)).toContain('no_trigger')

    const dup = clone()
    dup.nodes.push({ id: 'draft', type: 'verify', of: 'draft' })
    expect(codes(dup)).toContain('duplicate_node:draft')

    const dangling = clone()
    dangling.edges.push({ from: 'seal', to: 'ghost' })
    expect(codes(dangling)).toContain('unknown_edge_node:ghost')

    const fed = clone()
    fed.edges.push({ from: 'draft', to: 'start' })
    expect(codes(fed)).toContain('trigger_has_input:start')
  })

  test('graph: unreachable nodes and cycles', () => {
    const island = clone()
    island.nodes.push({ id: 'lonely', type: 'verify', of: 'draft' })
    expect(codes(island)).toContain('unreachable_node:lonely')

    const cyc = clone()
    cyc.edges.push({ from: 'seal', to: 'check' })
    expect(codes(cyc)).toContain('cycle')
  })

  test('graph: a path must end at a post', () => {
    const open = clone()
    open.nodes = open.nodes.filter((n) => n.id !== 'publish')
    open.edges = open.edges.filter((e) => e.to !== 'publish')
    expect(codes(open)).toContain('dead_end:seal')
  })

  test('references: Hall, template, Hall/template match, schedule', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') {
      throw new Error('template changed')
    }
    draft.hallId = 'nowhere'
    expect(codes(g)).toContain('unknown_hall:draft')
    draft.hallId = 'health'
    expect(codes(g)).toContain('hall_locked:draft')
    draft.hallId = 'heralds'
    draft.templateId = 'nope'
    expect(codes(g)).toContain('unknown_template:draft')
    draft.templateId = 'herald-announcement'
    expect(codes(g)).toEqual([])

    const sched = clone()
    sched.nodes.push({ id: 'cron', type: 'trigger.schedule', scheduleId: 'weekly' })
    sched.edges.push({ from: 'cron', to: 'draft' })
    expect(codes(sched)).toContain('unknown_schedule:cron')
    expect(codes(sched, config({ schedules: [{ id: 'weekly', cron: '0 9 * * 1' }] }))).toEqual([])
  })

  test('references: a brief may only name an upstream agent node', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') {
      throw new Error('template changed')
    }
    draft.briefTemplate = 'Use {{nodes.ghost.output}}'
    expect(codes(g)).toContain('bad_reference:draft')
    draft.briefTemplate = 'Use {{nodes.draft.output}}'
    expect(codes(g)).toContain('bad_reference:draft')
  })

  test('the gate rule: a post without verify then approval on every path is refused', () => {
    const skipApproval = clone()
    skipApproval.edges = [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'check' },
      { from: 'check', to: 'publish' },
      { from: 'check', to: 'seal' },
    ]
    expect(codes(skipApproval)).toContain('gate_unapproved:publish')

    const skipVerify = clone()
    skipVerify.edges = [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'seal' },
      { from: 'draft', to: 'check' },
      { from: 'seal', to: 'publish' },
    ]
    expect(codes(skipVerify)).toContain('gate_unverified:seal')

    const unsealed = clone()
    unsealed.edges = [
      { from: 'start', to: 'draft' },
      { from: 'draft', to: 'check' },
      { from: 'check', to: 'seal' },
      { from: 'draft', to: 'publish' },
      { from: 'seal', to: 'publish' },
    ]
    expect(codes(unsealed)).toContain('gate_unapproved:publish')
  })

  test('the gate rule: bindings must name the right node kinds and the same chain', () => {
    const wrong = clone()
    const seal = wrong.nodes.find((n) => n.id === 'seal')
    if (seal?.type !== 'approval') {
      throw new Error('template changed')
    }
    seal.of = 'draft'
    expect(codes(wrong)).toContain('bad_binding:seal')
  })

  test('the gate rule: the drafting Quest template must require a Seal', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') {
      throw new Error('template changed')
    }
    draft.templateId = 'herald-brief'
    expect(codes(g)).toContain('unsealed_template:draft')
  })

  test('budget: the sum of maxUsd stays within the daily spend cap', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') {
      throw new Error('template changed')
    }
    draft.maxUsd = 10
    expect(codes(g, config({ caps: { dailyTokens: 1, dailySpendCents: 1_000 } }))).toEqual([])
    draft.maxUsd = 10.01
    expect(codes(g, config({ caps: { dailyTokens: 1, dailySpendCents: 1_000 } }))).toContain(
      'budget_exceeded'
    )
  })

  test('an agent downstream of a verify or approval is refused (agent_after_gate)', () => {
    const g = clone()
    g.nodes.push({
      id: 'more',
      type: 'agent',
      hallId: 'heralds',
      templateId: 'herald-brief',
      briefTemplate: 'Follow up',
      doneCondition: 'Done',
      maxUsd: 0,
    })
    g.edges.push({ from: 'check', to: 'more' }, { from: 'more', to: 'publish' })
    expect(codes(g)).toContain('agent_after_gate:more')
  })
})

const subagentsNode = (over: Record<string, unknown> = {}) => ({
  id: 'fan',
  type: 'subagents' as const,
  hallId: 'heralds',
  templateId: 'herald-brief',
  briefs: ['one', 'two'],
  join: 'all' as const,
  maxUsd: 1,
  ...over,
})
const teamNode = (over: Record<string, unknown> = {}) => ({
  id: 'crew',
  type: 'team' as const,
  hallId: 'heralds',
  goal: 'Ship the launch notes',
  maxMembers: 2,
  maxQuests: 3,
  maxUsd: 1,
  ...over,
})
/** A trigger feeding one fan-out node. */
const fanGraph = (node: Record<string, unknown>) => ({
  nodes: [{ id: 'start', type: 'trigger.manual' }, node],
  edges: [{ from: 'start', to: String(node.id) }],
})
const withCaps = (caps: Partial<GuildConfig['caps']>): GuildConfig => {
  const c = config()
  return { ...c, caps: { ...c.caps, ...caps } }
}

describe('validateWorkflow: subagents and team nodes', () => {
  test('a valid fan-out and a valid team are accepted as path ends', () => {
    expect(codes(fanGraph(subagentsNode()))).toEqual([])
    expect(codes(fanGraph(teamNode()))).toEqual([])
  })

  test('subagents: N over maxChildrenPerQuest is children_cap', () => {
    const g = fanGraph(subagentsNode({ briefs: ['a', 'b', 'c', 'd'] }))
    expect(codes(g)).toEqual(['children_cap:fan'])
    expect(codes(g, withCaps({ maxChildrenPerQuest: 4 }))).toEqual([])
  })

  test('subagents: depth over maxSpawnDepth is depth_cap', () => {
    expect(codes(fanGraph(subagentsNode()), withCaps({ maxSpawnDepth: 0 }))).toEqual([
      'depth_cap:fan',
    ])
  })

  test('subagents: Hall and template references are checked', () => {
    expect(codes(fanGraph(subagentsNode({ hallId: 'ghost' })))).toContain('unknown_hall:fan')
    expect(codes(fanGraph(subagentsNode({ templateId: 'ghost' })))).toContain(
      'unknown_template:fan'
    )
  })

  test('team: maxMembers over the Hall cap is member_cap, maxQuests over the Campaign cap is campaign_cap', () => {
    const c = config()
    const halls = c.halls.map((h) => (h.id === 'heralds' ? { ...h, maxConcurrentMembers: 1 } : h))
    expect(codes(fanGraph(teamNode()), { ...c, halls })).toEqual(['member_cap:crew'])
    expect(codes(fanGraph(teamNode({ maxQuests: 11 })))).toEqual(['campaign_cap:crew'])
    expect(
      codes(fanGraph(teamNode({ maxQuests: 11 })), withCaps({ maxQuestsPerCampaign: 11 }))
    ).toEqual([])
  })

  test('team: a Hall without a Captain is no_captain; an unknown Hall is refused', () => {
    const c = config()
    const halls = c.halls.map((h) => (h.id === 'heralds' ? { ...h, captain: null } : h))
    expect(codes(fanGraph(teamNode()), { ...c, halls })).toEqual(['no_captain:crew'])
    expect(codes(fanGraph(teamNode({ hallId: 'ghost' })))).toContain('unknown_hall:crew')
  })

  test('team: nothing may run after a team node (agent_after_team)', () => {
    const g = clone()
    g.nodes.push(teamNode() as WorkflowGraph['nodes'][number])
    g.edges.push({ from: 'start', to: 'crew' }, { from: 'crew', to: 'draft' })
    expect(codes(g)).toContain('agent_after_team:draft')
  })

  test('the gate rule still holds with a fan-out beside the path to post', () => {
    const g = clone()
    g.nodes.push(subagentsNode() as WorkflowGraph['nodes'][number])
    g.edges.push({ from: 'start', to: 'fan' }, { from: 'fan', to: 'publish' })
    expect(codes(g)).toContain('gate_unapproved:publish')
  })

  test('subagents: briefs that cannot fit the coordinating Quest`s done condition are briefs_too_long', () => {
    const long = 'x'.repeat(500)
    const g = fanGraph(subagentsNode({ briefs: [long, long, long, long] }))
    expect(codes(g, withCaps({ maxChildrenPerQuest: 4 }))).toEqual(['briefs_too_long:fan'])
  })

  test('maxUsd of the new nodes counts against the daily spend cap', () => {
    const g = fanGraph(subagentsNode({ maxUsd: 11 }))
    expect(codes(g, withCaps({ dailySpendCents: 1_000 }))).toEqual(['budget_exceeded'])
  })
})
