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
export function diffGraphs(_from: RiteGraph, _to: RiteGraph): GraphDiff {
  return { nodesAdded: [], nodesRemoved: [], nodesChanged: [], edgesAdded: [], edgesRemoved: [] }
}
