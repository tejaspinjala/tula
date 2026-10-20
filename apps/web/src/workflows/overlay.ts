import type { Tone } from '../Badge'

/** One validation error as the server reports it. */
export interface WorkflowIssue {
  code: string
  nodeId?: string
  message: string
}

/** One node of a run as the server reports it. */
export interface RunNode {
  id: string
  type: string
  status: string
  questId: string | null
}

/** What the overlay shows on one node. */
export interface NodeOverlay {
  status: string
  tone: Tone
  /** The status in words; the colour and icon never carry the meaning alone. */
  text: string
  attempts: number | null
  costMicros: number | null
}

/** The validation errors split into those tied to a node and those about the whole graph. */
export function errorsByNode(_errors: WorkflowIssue[]): {
  byNode: Map<string, string[]>
  graphLevel: string[]
} {
  return { byNode: new Map(), graphLevel: [] }
}

/** The per-node overlay of a run, merging the Quest facts (attempts) and spend (micros) by Quest id. */
export function runOverlay(
  _nodes: RunNode[],
  _attempts: ReadonlyMap<string, number>,
  _costs: ReadonlyMap<string, number>
): Map<string, NodeOverlay> {
  return new Map()
}

/** Reads one event-stream frame: whether the open run should reload, and the cursor to resume from. */
export function readRunFrame(_raw: string): { refresh: boolean; seq: number | null } {
  return { refresh: false, seq: null }
}
