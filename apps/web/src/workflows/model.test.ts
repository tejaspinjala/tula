import { expect, test } from 'bun:test'
import { QUEST_TEMPLATES } from '../../../guildd/src/quests'
import { type WorkflowGraph, workflowNode } from '../../../guildd/src/workflows/graph'
import { addNode, connect, fieldsFor, paletteTypes, removeNode, saveBody, setField } from './model'

const start: WorkflowGraph = { nodes: [{ id: 'trigger', type: 'trigger.manual' }], edges: [] }

test('the palette lists every node type the shared schema defines', () => {
  expect(paletteTypes()).toEqual([
    'trigger.manual',
    'trigger.schedule',
    'agent',
    'subagents',
    'team',
    'verify',
    'approval',
    'post',
  ])
})

test('the inspector fields of a subagents node: briefs are lines, the fan-in is a choice', () => {
  expect(fieldsFor('subagents').map((f) => [f.key, f.kind])).toEqual([
    ['name', 'string'],
    ['hallId', 'string'],
    ['templateId', 'string'],
    ['briefs', 'lines'],
    ['join', 'choice'],
    ['maxUsd', 'number'],
  ])
  expect(fieldsFor('subagents').find((f) => f.key === 'join')?.options).toEqual(['all', 'any'])
  expect(fieldsFor('team').map((f) => [f.key, f.kind])).toEqual([
    ['name', 'string'],
    ['hallId', 'string'],
    ['goal', 'string'],
    ['maxMembers', 'number'],
    ['maxQuests', 'number'],
    ['maxUsd', 'number'],
  ])
})

test('new fan-out nodes start with fields the schema accepts', () => {
  for (const type of ['subagents', 'team']) {
    const graph = addNode(start, type)
    expect(workflowNode.safeParse(graph.nodes.at(-1)).success).toBe(true)
  }
  const edited = setField(addNode(start, 'subagents'), 'subagents', 'briefs', ['a', 'b'])
  expect(edited.nodes.at(-1)).toMatchObject({ briefs: ['a', 'b'] })
})

test('a graph edit becomes the save body: dropped nodes, a connection, and the gate reference', () => {
  let graph = addNode(start, 'agent')
  graph = addNode(graph, 'verify')
  graph = addNode(graph, 'agent')
  graph = connect(graph, 'trigger', 'agent')
  graph = connect(graph, 'agent', 'verify')
  graph = connect(graph, 'agent', 'verify')
  graph = connect(graph, 'verify', 'verify')
  const body = saveBody('Mine', graph)
  expect(body.name).toBe('Mine')
  expect(body.graph.nodes.map((n) => [n.id, n.type])).toEqual([
    ['trigger', 'trigger.manual'],
    ['agent', 'agent'],
    ['verify', 'verify'],
    ['agent-2', 'agent'],
  ])
  expect(body.graph.edges).toEqual([
    { from: 'trigger', to: 'agent' },
    { from: 'agent', to: 'verify' },
  ])
  expect(body.graph.nodes.find((n) => n.id === 'verify')).toMatchObject({ of: 'agent' })
})

test('removing a node drops its edges', () => {
  let graph = addNode(start, 'agent')
  graph = connect(graph, 'trigger', 'agent')
  expect(removeNode(graph, 'agent')).toEqual(start)
})

test('a new agent node uses a Quest template that requires a Seal, so a gate after it validates', () => {
  const agent = addNode(start, 'agent').nodes.find((n) => n.type === 'agent')
  const template = QUEST_TEMPLATES.find((t) => agent?.type === 'agent' && t.id === agent.templateId)
  expect(template?.requiresSeal).toBe(true)
  expect(agent?.type === 'agent' ? agent.hallId : null).toBe(template?.hallId ?? null)
})
