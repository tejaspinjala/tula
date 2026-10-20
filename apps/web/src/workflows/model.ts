import {
  type WorkflowGraph,
  type WorkflowNode,
  workflowNode,
} from '../../../guildd/src/workflows/graph'

/** The node types the shared graph schema defines, in schema order: the palette is generated from this. */
export function paletteTypes(): string[] {
  return workflowNode.options.map((option) => option.shape.type.value)
}

/** The fields the inspector edits, in schema order, with the kind of control each needs. */
export interface FieldSpec {
  key: string
  kind: 'string' | 'number'
  optional: boolean
}

/** The editable fields of a node type, read from the shared schema (`id` and `type` are structural). */
export function fieldsFor(type: string): FieldSpec[] {
  const option = workflowNode.options.find((o) => o.shape.type.value === type)
  if (!option) {
    return []
  }
  const fields: FieldSpec[] = []
  for (const [key, field] of Object.entries(option.shape)) {
    if (key === 'id' || key === 'type') {
      continue
    }
    const optional = field.type === 'optional'
    const inner = 'unwrap' in field && typeof field.unwrap === 'function' ? field.unwrap() : field
    const kind =
      typeof inner === 'object' && inner !== null && 'type' in inner && inner.type === 'number'
        ? 'number'
        : 'string'
    fields.push({ key, kind, optional })
  }
  return fields
}

/** Fresh-node defaults. The server's validator stays the authority on whether they are enough. */
function defaults(type: WorkflowNode['type'], id: string): WorkflowNode {
  switch (type) {
    case 'trigger.manual':
      return { id, type }
    case 'trigger.schedule':
      return { id, type, scheduleId: 'daily' }
    case 'agent':
      return {
        id,
        type,
        hallId: 'heralds',
        templateId: 'herald-brief',
        briefTemplate: 'Describe the work to do.',
        doneCondition: 'The work is filed in the Archive',
        maxUsd: 1,
      }
    case 'verify':
    case 'approval':
    case 'post':
      return { id, type, of: '' }
  }
}

function freshId(graph: WorkflowGraph, type: string): string {
  const stem = type.replace(/[^a-z0-9_-]+/g, '-')
  const taken = new Set(graph.nodes.map((n) => n.id))
  if (!taken.has(stem)) {
    return stem
  }
  for (let n = 2; ; n++) {
    if (!taken.has(`${stem}-${n}`)) {
      return `${stem}-${n}`
    }
  }
}

/** Adds a node of `type` with a fresh id and valid-shaped defaults. An unknown type adds nothing. */
export function addNode(graph: WorkflowGraph, type: string): WorkflowGraph {
  const option = workflowNode.options.find((o) => o.shape.type.value === type)
  if (!option) {
    return graph
  }
  const id = freshId(graph, type)
  return { ...graph, nodes: [...graph.nodes, defaults(option.shape.type.value, id)] }
}

/** Adds the edge `from -> to` (no self edges or duplicates); a node with an `of` reference takes `from`. */
export function connect(graph: WorkflowGraph, from: string, to: string): WorkflowGraph {
  const known = new Set(graph.nodes.map((n) => n.id))
  if (from === to || !known.has(from) || !known.has(to)) {
    return graph
  }
  const nodes = graph.nodes.map((n) =>
    n.id === to && 'of' in n ? Object.assign({}, n, { of: from }) : n
  )
  if (graph.edges.some((e) => e.from === from && e.to === to)) {
    return { ...graph, nodes }
  }
  return { nodes, edges: [...graph.edges, { from, to }] }
}

/** Removes the edge `from -> to`. */
export function disconnect(graph: WorkflowGraph, from: string, to: string): WorkflowGraph {
  return { ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.to === to)) }
}

/** Removes a node and every edge that touches it. */
export function removeNode(graph: WorkflowGraph, id: string): WorkflowGraph {
  return {
    nodes: graph.nodes.filter((n) => n.id !== id),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

/** Sets one field of a node. The value is not checked here: the server's validation is the authority. */
export function setField(
  graph: WorkflowGraph,
  id: string,
  key: string,
  value: string | number | undefined
): WorkflowGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? Object.assign({}, n, { [key]: value }) : n)),
  }
}

/** The `PUT /workflows/:wid` body. */
export function saveBody(
  name: string,
  graph: WorkflowGraph
): { name: string; graph: WorkflowGraph } {
  return { name, graph }
}
