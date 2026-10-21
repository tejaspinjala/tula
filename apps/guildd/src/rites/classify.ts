import { canonicalJson } from '../audit-chain'
import type { RiteGraph, RiteNode } from './graph'

/** How a rite save moves risk: `widening` waits for confirmation with a fresh re-authentication. */
export type RiteChangeKind = 'internal' | 'widening'

const EMPTY: RiteGraph = { nodes: [], edges: [] }

const isGate = (n: RiteNode) => n.type === 'verify' || n.type === 'approval' || n.type === 'post'

/** A node without its display name: only what can carry risk. */
const risk = (n: RiteNode): string => {
  const { name: _name, ...rest } = n
  return canonicalJson(rest)
}

const edgeKey = (e: { from: string; to: string }) => `${e.from}>${e.to}`

function budgetMicros(g: RiteGraph): number {
  return g.nodes.reduce(
    (sum, n) =>
      sum +
      (n.type === 'agent' || n.type === 'subagents' || n.type === 'team'
        ? Math.round(n.maxUsd * 1e6)
        : 0),
    0
  )
}

/**
 * Deterministic comparison of a new version against the previous one (none for a first save),
 * failing closed: only a provable subset of risk is `internal`. Widening is any new or changed
 * `post`; a removed or reconfigured `verify` or `approval`; a new edge into a gate node; a new
 * schedule trigger; a new Hall and Quest template pair; or a higher total budget. Names and
 * briefs do not move risk. Never a model decision.
 */
export function classifyRiteChange(prev: RiteGraph | null, next: RiteGraph): RiteChangeKind {
  const before = prev ?? EMPTY
  const prevGates = new Map(before.nodes.filter(isGate).map((n) => [n.id, risk(n)]))
  const nextGates = new Map(next.nodes.filter(isGate).map((n) => [n.id, risk(n)]))
  const postsKept = next.nodes
    .filter((n) => n.type === 'post')
    .every((n) => prevGates.get(n.id) === nextGates.get(n.id))
  const gatesKept = before.nodes
    .filter((n) => n.type === 'verify' || n.type === 'approval')
    .every((n) => nextGates.get(n.id) === prevGates.get(n.id))
  const gateIds = new Set(next.nodes.filter(isGate).map((n) => n.id))
  const prevEdges = new Set(before.edges.map(edgeKey))
  const edgesKept = next.edges
    .filter((e) => gateIds.has(e.to))
    .every((e) => prevEdges.has(edgeKey(e)))
  const schedules = new Set(
    before.nodes.flatMap((n) => (n.type === 'trigger.schedule' ? [n.scheduleId] : []))
  )
  const schedulesKept = next.nodes.every(
    (n) => n.type !== 'trigger.schedule' || schedules.has(n.scheduleId)
  )
  const pairs = new Set(
    before.nodes.flatMap((n) => (n.type === 'agent' ? [`${n.hallId}/${n.templateId}`] : []))
  )
  const pairsKept = next.nodes.every(
    (n) => n.type !== 'agent' || pairs.has(`${n.hallId}/${n.templateId}`)
  )
  // A fan-out or team node spends and spawns work, so any new or changed one widens risk.
  const isFanout = (n: RiteNode) => n.type === 'subagents' || n.type === 'team'
  const prevFanouts = new Set(before.nodes.filter(isFanout).map(risk))
  const fanoutsKept = next.nodes.filter(isFanout).every((n) => prevFanouts.has(risk(n)))
  const internal =
    postsKept &&
    fanoutsKept &&
    gatesKept &&
    edgesKept &&
    schedulesKept &&
    pairsKept &&
    budgetMicros(next) <= budgetMicros(before)
  return internal ? 'internal' : 'widening'
}
