import type { WorkflowGraph } from '../../../guildd/src/workflows/graph'

/** The node types the shared graph schema defines, in schema order: the palette is generated from this. */
export function paletteTypes(): string[] {
  return []
}

/** Adds a node of `type` with a fresh id and valid-shaped defaults. */
export function addNode(graph: WorkflowGraph, _type: string): WorkflowGraph {
  return graph
}

/** Adds the edge `from -> to` (no self edges or duplicates); a node with an `of` reference takes `from`. */
export function connect(graph: WorkflowGraph, _from: string, _to: string): WorkflowGraph {
  return graph
}

/** Removes a node and every edge that touches it. */
export function removeNode(graph: WorkflowGraph, _id: string): WorkflowGraph {
  return graph
}

/** The `PUT /workflows/:wid` body. */
export function saveBody(
  name: string,
  graph: WorkflowGraph
): { name: string; graph: WorkflowGraph } {
  return { name, graph }
}
