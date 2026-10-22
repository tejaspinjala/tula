import type { RiteGraph } from '../../../guildd/src/rites/graph'

/** An edge as the diff names it. */
export interface DiffEdge {
  from: string
  to: string
}

/** One node present in both graphs whose kind or config differs. */
export interface NodeChange {
  id: string
  /** The old and new node type, or null when the kind is unchanged. */
  kind: { from: string; to: string } | null
  /** The config fields whose value differs (excluding the type). */
  config: string[]
}

/** What changed from one graph to another. */
export interface GraphDiff {
  nodesAdded: string[]
  nodesRemoved: string[]
  nodesChanged: NodeChange[]
  edgesAdded: DiffEdge[]
  edgesRemoved: DiffEdge[]
}

/** Compares two Rite graphs: what `to` adds, removes and changes relative to `from`. */
export function diffGraphs(from: RiteGraph, to: RiteGraph): GraphDiff {
  const before = new Map(from.nodes.map((n) => [n.id, n]))
  const after = new Map(to.nodes.map((n) => [n.id, n]))
  const nodesChanged: NodeChange[] = []
  for (const [id, next] of after) {
    const prev = before.get(id)
    if (!prev) {
      continue
    }
    const kind = prev.type === next.type ? null : { from: prev.type, to: next.type }
    const prevFields: Record<string, unknown> = { ...prev }
    const nextFields: Record<string, unknown> = { ...next }
    const config = [...new Set([...Object.keys(prevFields), ...Object.keys(nextFields)])]
      .filter((key) => key !== 'id' && key !== 'type')
      .filter((key) => JSON.stringify(prevFields[key]) !== JSON.stringify(nextFields[key]))
    if (kind || config.length > 0) {
      nodesChanged.push({ id, kind, config })
    }
  }
  const edgeKey = (e: DiffEdge) => `${e.from}\u0000${e.to}`
  const had = new Set(from.edges.map(edgeKey))
  const has = new Set(to.edges.map(edgeKey))
  return {
    nodesAdded: [...after.keys()].filter((id) => !before.has(id)),
    nodesRemoved: [...before.keys()].filter((id) => !after.has(id)),
    nodesChanged,
    edgesAdded: to.edges.filter((e) => !had.has(edgeKey(e))),
    edgesRemoved: from.edges.filter((e) => !has.has(edgeKey(e))),
  }
}

/** The diff as short plain lines for the history row; empty when nothing differs. */
export function describeDiff(diff: GraphDiff): string[] {
  return [
    ...diff.nodesAdded.map((id) => `Added node ${id}`),
    ...diff.nodesRemoved.map((id) => `Removed node ${id}`),
    ...diff.nodesChanged.map((c) => {
      const parts = [
        ...(c.kind ? [`kind ${c.kind.from} to ${c.kind.to}`] : []),
        ...(c.config.length > 0 ? [`config ${c.config.join(', ')}`] : []),
      ]
      return `Changed node ${c.id}: ${parts.join('; ')}`
    }),
    ...diff.edgesAdded.map((e) => `Added edge ${e.from} to ${e.to}`),
    ...diff.edgesRemoved.map((e) => `Removed edge ${e.from} to ${e.to}`),
  ]
}
