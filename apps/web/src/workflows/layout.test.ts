import { expect, test } from 'bun:test'
import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'
import { COLUMN, layout, ROW } from './layout'

test('nodes sit in columns by longest path, and siblings stack in rows', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'a', type: 'trigger.manual' },
      { id: 'b', type: 'verify', of: 'a' },
      { id: 'c', type: 'verify', of: 'a' },
      { id: 'd', type: 'approval', of: 'b' },
      { id: 'loose', type: 'post', of: 'x' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'a', to: 'c' },
      { from: 'b', to: 'd' },
      { from: 'a', to: 'd' },
    ],
  }
  const places = layout(graph)
  expect(places.get('a')).toEqual({ x: 0, y: 0 })
  expect(places.get('b')).toEqual({ x: COLUMN, y: 0 })
  expect(places.get('c')).toEqual({ x: COLUMN, y: ROW })
  expect(places.get('loose')).toEqual({ x: 0, y: ROW })
  expect(places.get('d')).toEqual({ x: 2 * COLUMN, y: 0 })
})

test('a cycle does not hang the layout', () => {
  const graph: WorkflowGraph = {
    nodes: [
      { id: 'a', type: 'verify', of: 'b' },
      { id: 'b', type: 'verify', of: 'a' },
    ],
    edges: [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'a' },
    ],
  }
  expect(layout(graph).size).toBe(2)
})
