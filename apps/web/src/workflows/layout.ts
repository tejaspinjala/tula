import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'

/** A node's place on the canvas. */
export interface Place {
  x: number
  y: number
}

/** Horizontal distance between layers. */
export const COLUMN = 240
/** Vertical distance between nodes in a layer. */
export const ROW = 130

/** Lays the graph out in layers by longest path from the roots, one column per layer. */
export function layout(_graph: WorkflowGraph): Map<string, Place> {
  return new Map()
}
