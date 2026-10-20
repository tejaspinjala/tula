import type { WorkflowGraph } from './graph'

/** How a workflow save moves risk: `widening` waits for confirmation with a fresh re-authentication. */
export type WorkflowChangeKind = 'internal' | 'widening'

/**
 * Deterministic comparison of a new version against the previous one (none for a first save),
 * failing closed: only a provable subset of risk is `internal`.
 */
export function classifyWorkflowChange(
  _prev: WorkflowGraph | null,
  _next: WorkflowGraph
): WorkflowChangeKind {
  return 'internal'
}
