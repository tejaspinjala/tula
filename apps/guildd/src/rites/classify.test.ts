import { describe, expect, test } from 'bun:test'
import { classifyRiteChange } from './classify'
import type { RiteGraph } from './graph'
import { LEARNING_TO_LINKEDIN } from './templates'

const base = (): RiteGraph => structuredClone(LEARNING_TO_LINKEDIN)
const agentOf = (g: RiteGraph) => {
  const n = g.nodes.find((x) => x.id === 'draft')
  if (n?.type !== 'agent') {
    throw new Error('template changed')
  }
  return n
}

describe('classifyRiteChange', () => {
  test('a first version that can post is widening', () => {
    expect(classifyRiteChange(null, base())).toBe('widening')
  })

  test('renames and brief edits are internal', () => {
    const next = base()
    agentOf(next).briefTemplate = 'A different brief'
    agentOf(next).name = 'Renamed'
    expect(classifyRiteChange(base(), next)).toBe('internal')
  })

  test('lowering the budget or removing a node is internal', () => {
    const lower = base()
    agentOf(lower).maxUsd = 0.5
    expect(classifyRiteChange(base(), lower)).toBe('internal')
  })

  test('raising the budget is widening', () => {
    const higher = base()
    agentOf(higher).maxUsd = 2
    expect(classifyRiteChange(base(), higher)).toBe('widening')
  })

  test('adding a post, a schedule trigger or a different Quest template is widening', () => {
    const post = base()
    post.nodes.push({ id: 'again', type: 'post', of: 'seal' })
    post.edges.push({ from: 'seal', to: 'again' })
    expect(classifyRiteChange(base(), post)).toBe('widening')

    const sched = base()
    sched.nodes.push({ id: 'cron', type: 'trigger.schedule', scheduleId: 'weekly' })
    sched.edges.push({ from: 'cron', to: 'draft' })
    expect(classifyRiteChange(base(), sched)).toBe('widening')

    const template = base()
    agentOf(template).templateId = 'herald-brief'
    expect(classifyRiteChange(base(), template)).toBe('widening')
  })

  test('removing or rewiring a gate is widening', () => {
    const rewired = base()
    const seal = rewired.nodes.find((n) => n.id === 'seal')
    if (seal?.type !== 'approval') {
      throw new Error('template changed')
    }
    seal.of = 'draft'
    expect(classifyRiteChange(base(), rewired)).toBe('widening')

    const bypass = base()
    bypass.edges.push({ from: 'draft', to: 'publish' })
    expect(classifyRiteChange(base(), bypass)).toBe('widening')
  })
})
