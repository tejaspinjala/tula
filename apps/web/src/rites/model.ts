import { z } from 'zod'
import { type RiteGraph, type RiteNode, riteNode } from '../../../guildd/src/rites/graph'

/** The node types the shared graph schema defines, in schema order: the palette is generated from this. */
export function paletteTypes(): string[] {
  return riteNode.options.map((option) => option.shape.type.value)
}

/** The fields the inspector edits, in schema order, with the kind of control each needs. */
export interface FieldSpec {
  key: string
  kind: 'string' | 'number' | 'lines' | 'choice'
  optional: boolean
  /** The allowed values of a `choice` field. */
  options?: string[]
}

/** The editable fields of a node type, read from the shared schema (`id` and `type` are structural). */
export function fieldsFor(type: string): FieldSpec[] {
  const option = riteNode.options.find((o) => o.shape.type.value === type)
  if (!option) {
    return []
  }
  const fields: FieldSpec[] = []
  for (const [key, field] of Object.entries(option.shape)) {
    if (key === 'id' || key === 'type') {
      continue
    }
    const optional = field.type === 'optional'
    const inner =
      optional && 'unwrap' in field && typeof field.unwrap === 'function' ? field.unwrap() : field
    const innerType =
      typeof inner === 'object' && inner !== null && 'type' in inner ? inner.type : ''
    if (innerType === 'array') {
      fields.push({ key, kind: 'lines', optional })
    } else if (innerType === 'enum' && 'options' in inner) {
      const options = z.array(z.string()).safeParse(inner.options)
      fields.push({ key, kind: 'choice', optional, options: options.success ? options.data : [] })
    } else {
      fields.push({ key, kind: innerType === 'number' ? 'number' : 'string', optional })
    }
  }
  return fields
}

/** Fresh-node defaults. The server's validator stays the authority on whether they are enough. */
function defaults(type: RiteNode['type'], id: string): RiteNode {
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
        templateId: 'herald-announcement',
        briefTemplate: 'Describe the work to do.',
        doneCondition: 'An announcement draft is ready for a Seal',
        maxUsd: 1,
      }
    case 'subagents':
      return {
        id,
        type,
        hallId: 'heralds',
        templateId: 'herald-brief',
        briefs: ['Describe the first piece of work.'],
        join: 'all',
        maxUsd: 1,
      }
    case 'team':
      return {
        id,
        type,
        hallId: 'heralds',
        goal: 'Describe the goal for the team.',
        maxMembers: 2,
        maxQuests: 3,
        maxUsd: 1,
      }
    case 'verify':
    case 'approval':
    case 'post':
      return { id, type, of: '' }
  }
}

function freshId(graph: RiteGraph, type: string): string {
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
export function addNode(graph: RiteGraph, type: string): RiteGraph {
  const option = riteNode.options.find((o) => o.shape.type.value === type)
  if (!option) {
    return graph
  }
  const id = freshId(graph, type)
  return { ...graph, nodes: [...graph.nodes, defaults(option.shape.type.value, id)] }
}

/** Adds the edge `from -> to` (no self edges or duplicates); a node with an `of` reference takes `from`. */
export function connect(graph: RiteGraph, from: string, to: string): RiteGraph {
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
export function disconnect(graph: RiteGraph, from: string, to: string): RiteGraph {
  return { ...graph, edges: graph.edges.filter((e) => !(e.from === from && e.to === to)) }
}

/** Removes a node and every edge that touches it. */
export function removeNode(graph: RiteGraph, id: string): RiteGraph {
  return {
    nodes: graph.nodes
      .filter((n) => n.id !== id)
      .map((n) => ('of' in n && n.of === id ? { ...n, of: '' } : n)),
    edges: graph.edges.filter((e) => e.from !== id && e.to !== id),
  }
}

/** Sets one field of a node. The value is not checked here: the server's validation is the authority. */
export function setField(
  graph: RiteGraph,
  id: string,
  key: string,
  value: string | number | string[] | undefined
): RiteGraph {
  return {
    ...graph,
    nodes: graph.nodes.map((n) => (n.id === id ? Object.assign({}, n, { [key]: value }) : n)),
  }
}

/** The version line under the Rite picker. */
export function versionLine(version: number, activeVersion: number | null): string {
  return version === 0
    ? 'Not saved yet.'
    : activeVersion === null
      ? `Version ${version}, not yet in force.`
      : version === activeVersion
        ? `Viewing v${version}, in force`
        : `Viewing v${version} \u00b7 v${activeVersion} in force`
}

/**
 * Whether a pending version can no longer be confirmed. The server refuses a confirm unless the
 * version was based on the version now in force (none counts as null), so anything else is stale.
 */
export function isStalePending(
  row: { status: string; basedOn: number | null },
  activeVersion: number | null
): boolean {
  return row.status === 'pending' && row.basedOn !== activeVersion
}

/** What the editor chip says about the version on screen: unsaved edits and drafts are a Draft. */
export function riteChip(status: string | null, dirty: boolean): 'Draft' | 'Pending' | 'Live' {
  if (dirty || status === 'draft' || status === null) {
    return 'Draft'
  }
  return status === 'pending' ? 'Pending' : 'Live'
}

/** The `PUT /rites/:wid` body. */
export function saveBody(name: string, graph: RiteGraph): { name: string; graph: RiteGraph } {
  return { name, graph }
}
