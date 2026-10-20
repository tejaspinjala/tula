import { expect, test } from 'bun:test'
import { errorsByNode, readRunFrame, runOverlay } from './overlay'

test('validation errors map to their node; the rest are about the whole graph', () => {
  const split = errorsByNode([
    { code: 'agent_after_gate', nodeId: 'late', message: 'agent late runs after a verify gate' },
    { code: 'no_trigger', message: 'a workflow needs at least one trigger' },
    { code: 'unreachable_node', nodeId: 'late', message: 'node late cannot be reached' },
  ])
  expect(split.byNode.get('late')).toEqual([
    'agent late runs after a verify gate',
    'node late cannot be reached',
  ])
  expect(split.graphLevel).toEqual(['a workflow needs at least one trigger'])
})

test('the run overlay carries status in words and tone, with attempts and cost from the Quest', () => {
  const overlay = runOverlay(
    [
      { id: 'start', type: 'trigger.manual', status: 'done', questId: null },
      { id: 'draft', type: 'agent', status: 'running', questId: 'q1' },
      { id: 'check', type: 'verify', status: 'pending', questId: null },
      { id: 'bad', type: 'agent', status: 'failed', questId: 'q2' },
      { id: 'seal', type: 'approval', status: 'awaiting', questId: null },
    ],
    new Map([['q1', 2]]),
    new Map([['q1', 12_500]])
  )
  expect(overlay.get('draft')).toEqual({
    status: 'running',
    tone: 'info',
    text: 'Running',
    attempts: 2,
    costMicros: 12_500,
  })
  expect(overlay.get('start')).toMatchObject({ tone: 'ok', text: 'Done', attempts: null })
  expect(overlay.get('check')).toMatchObject({ tone: 'neutral', text: 'Waiting' })
  expect(overlay.get('bad')).toMatchObject({ tone: 'danger', text: 'Failed' })
  expect(overlay.get('seal')).toMatchObject({ tone: 'warn', text: 'Awaiting' })
})

test('quest and workflow events reload the open run; other events only move the cursor', () => {
  const frame = (type: string, seq: number) =>
    JSON.stringify({ type: 'event', event: { type, seq } })
  expect(readRunFrame(frame('quest.completed', 7))).toEqual({ refresh: true, seq: 7 })
  expect(readRunFrame(frame('workflow.run_started', 8))).toEqual({ refresh: true, seq: 8 })
  expect(readRunFrame(frame('seal.requested', 9))).toEqual({ refresh: true, seq: 9 })
  expect(readRunFrame(frame('treasury.spent', 10))).toEqual({ refresh: false, seq: 10 })
  expect(readRunFrame(JSON.stringify({ type: 'snapshot' }))).toEqual({ refresh: true, seq: null })
  expect(readRunFrame('not json')).toEqual({ refresh: false, seq: null })
})

test('a gate node that shares its agent Quest does not repeat the agent attempts and cost', () => {
  const overlay = runOverlay(
    [
      { id: 'draft', type: 'agent', status: 'running', questId: 'q1' },
      { id: 'check', type: 'verify', status: 'pending', questId: 'q1' },
      { id: 'seal', type: 'approval', status: 'pending', questId: 'q1' },
    ],
    new Map([['q1', 2]]),
    new Map([['q1', 12_500]])
  )
  expect(overlay.get('draft')).toMatchObject({ attempts: 2, costMicros: 12_500 })
  expect(overlay.get('check')).toMatchObject({ attempts: null, costMicros: null })
  expect(overlay.get('seal')).toMatchObject({ attempts: null, costMicros: null })
})
