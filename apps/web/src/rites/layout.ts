import type { RiteGraph } from '../../../guildd/src/rites/graph'

/** A node's place on the canvas. */
export interface Place {
  x: number
  y: number
}

/** Horizontal distance between layers. */
export const COLUMN = 260
/** Vertical distance between nodes in a layer. */
export const ROW = 130

/** Lays the graph out in layers by longest path from the roots, one column per layer. */
export function layout(graph: RiteGraph): Map<string, Place> {
  const depth = new Map(graph.nodes.map((n) => [n.id, 0]))
  // Relax at most one pass per node, so a cycle (which the server refuses) cannot loop forever.
  for (let pass = 0; pass < graph.nodes.length; pass++) {
    let changed = false
    for (const e of graph.edges) {
      const from = depth.get(e.from)
      const to = depth.get(e.to)
      if (from !== undefined && to !== undefined && to < from + 1 && from < graph.nodes.length) {
        depth.set(e.to, from + 1)
        changed = true
      }
    }
    if (!changed) {
      break
    }
  }
  const rows = new Map<number, number>()
  const places = new Map<string, Place>()
  for (const n of graph.nodes) {
    const column = depth.get(n.id) ?? 0
    const row = rows.get(column) ?? 0
    rows.set(column, row + 1)
    places.set(n.id, { x: column * COLUMN, y: row * ROW })
  }
  return places
}
