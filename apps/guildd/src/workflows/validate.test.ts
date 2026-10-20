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
    if (draft?.type !== 'agent') throw new Error('template changed')
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
    if (draft?.type !== 'agent') throw new Error('template changed')
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
    if (seal?.type !== 'approval') throw new Error('template changed')
    seal.of = 'draft'
    expect(codes(wrong)).toContain('bad_binding:seal')
  })

  test('the gate rule: the drafting Quest template must require a Seal', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') throw new Error('template changed')
    draft.templateId = 'herald-brief'
    expect(codes(g)).toContain('unsealed_template:draft')
  })

  test('budget: the sum of maxUsd stays within the daily spend cap', () => {
    const g = clone()
    const draft = g.nodes.find((n) => n.id === 'draft')
    if (draft?.type !== 'agent') throw new Error('template changed')
    draft.maxUsd = 10
    expect(codes(g, config({ caps: { dailyTokens: 1, dailySpendCents: 1_000 } }))).toEqual([])
    draft.maxUsd = 10.01
    expect(codes(g, config({ caps: { dailyTokens: 1, dailySpendCents: 1_000 } }))).toContain(
      'budget_exceeded'
    )
  })
})
