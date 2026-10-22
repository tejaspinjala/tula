import { expect, test } from 'bun:test'
import type { RiteGraph } from '../../../guildd/src/rites/graph'
import { diffGraphs } from './diff'

const trigger = { id: 'start', type: 'trigger.manual' } as const

const base: RiteGraph = {
  nodes: [trigger, { id: 'work', type: 'verify', of: 'a' }],
  edges: [{ from: 'start', to: 'work' }],
}

test('identical graphs have an empty diff', () => {
  expect(diffGraphs(base, structuredClone(base))).toEqual({
    nodesAdded: [],
    nodesRemoved: [],
    nodesChanged: [],
    edgesAdded: [],
    edgesRemoved: [],
  })
})

test('nodes only in the new graph are added and only in the old graph are removed', () => {
  const next: RiteGraph = { nodes: [trigger, { id: 'out', type: 'post', of: 'a' }], edges: [] }
  const diff = diffGraphs(base, next)
  expect(diff.nodesAdded).toEqual(['out'])
  expect(diff.nodesRemoved).toEqual(['work'])
})

test('a node whose kind changed is reported with the old and new kind', () => {
  const next: RiteGraph = {
    nodes: [trigger, { id: 'work', type: 'post', of: 'a' }],
    edges: base.edges,
  }
  expect(diffGraphs(base, next).nodesChanged).toEqual([
    { id: 'work', kind: { from: 'verify', to: 'post' }, config: [] },
  ])
})

test('a node whose config changed lists the changed fields', () => {
  const next: RiteGraph = {
    nodes: [trigger, { id: 'work', type: 'verify', of: 'b' }],
    edges: base.edges,
  }
  expect(diffGraphs(base, next).nodesChanged).toEqual([{ id: 'work', kind: null, config: ['of'] }])
})

test('edges are compared by their endpoints, added and removed', () => {
  const next: RiteGraph = { nodes: base.nodes, edges: [{ from: 'work', to: 'start' }] }
  const diff = diffGraphs(base, next)
  expect(diff.edgesAdded).toEqual([{ from: 'work', to: 'start' }])
  expect(diff.edgesRemoved).toEqual([{ from: 'start', to: 'work' }])
})
