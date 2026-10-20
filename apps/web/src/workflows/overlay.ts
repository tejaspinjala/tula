import { z } from 'zod'
import type { Tone } from '../Badge'

/** One validation error as the server reports it. */
export interface WorkflowIssue {
  code: string
  nodeId?: string | undefined
  message: string
}

/** One node of a run as the server reports it. */
export interface RunNode {
  id: string
  type: string
  status: string
  questId: string | null
  /** A `subagents` or `team` node's output: the artifact hashes its finished Quests produced. */
  refs?: string[]
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
export function errorsByNode(errors: WorkflowIssue[]): {
  byNode: Map<string, string[]>
  graphLevel: string[]
} {
  const byNode = new Map<string, string[]>()
  const graphLevel: string[] = []
  for (const error of errors) {
    if (error.nodeId === undefined) {
      graphLevel.push(error.message)
    } else {
      byNode.set(error.nodeId, [...(byNode.get(error.nodeId) ?? []), error.message])
    }
  }
  return { byNode, graphLevel }
}

const STATUS: Record<string, { tone: Tone; text: string }> = {
  pending: { tone: 'neutral', text: 'Waiting' },
  queued: { tone: 'neutral', text: 'Queued' },
  running: { tone: 'info', text: 'Running' },
  publishing: { tone: 'info', text: 'Publishing' },
  awaiting_seal: { tone: 'warn', text: 'Awaiting Seal' },
  awaiting: { tone: 'warn', text: 'Awaiting' },
  done: { tone: 'ok', text: 'Done' },
  passed: { tone: 'ok', text: 'Passed' },
  approved: { tone: 'ok', text: 'Approved' },
  failed: { tone: 'danger', text: 'Failed' },
  rejected: { tone: 'danger', text: 'Rejected' },
}

/** The per-node overlay of a run, merging the Quest facts (attempts) and spend (micros) by Quest id. */
export function runOverlay(
  nodes: RunNode[],
  attempts: ReadonlyMap<string, number>,
  costs: ReadonlyMap<string, number>
): Map<string, NodeOverlay> {
  const overlay = new Map<string, NodeOverlay>()
  for (const node of nodes) {
    const own = node.type === 'agent' ? node.questId : null
    const shown = STATUS[node.status] ?? { tone: 'neutral' as const, text: node.status }
    overlay.set(node.id, {
      status: node.status,
      ...shown,
      // Gate nodes carry their agent's Quest id; only the agent node owns its attempts and spend.
      attempts: own === null ? null : (attempts.get(own) ?? null),
      costMicros: own === null ? null : (costs.get(own) ?? null),
    })
  }
  return overlay
}

const RELEVANT = ['quest.', 'workflow.', 'seal.', 'proposal.', 'verdict.']

const frame = z.union([
  z.object({ type: z.literal('event'), event: z.object({ type: z.string(), seq: z.number() }) }),
  z.object({ type: z.literal('snapshot') }),
])

/** Reads one event-stream frame: whether the open run should reload, and the cursor to resume from. */
export function readRunFrame(raw: string): { refresh: boolean; seq: number | null } {
  let data: unknown = null
  try {
    data = JSON.parse(raw)
  } catch {
    return { refresh: false, seq: null }
  }
  const parsed = frame.safeParse(data)
  if (!parsed.success) {
    return { refresh: false, seq: null }
  }
  if (parsed.data.type === 'snapshot') {
    return { refresh: true, seq: null }
  }
  const { type, seq } = parsed.data.event
  return { refresh: RELEVANT.some((prefix) => type.startsWith(prefix)), seq }
}
