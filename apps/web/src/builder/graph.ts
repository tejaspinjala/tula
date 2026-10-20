import type { Edge, Node } from '@xyflow/react'
import type { ConfigIssue } from './api'
import type { BuilderConfig, BuilderHall, BuilderMember } from './model'

/** Data of the Steward node. */
export type StewardData = { kind: 'steward'; name: string }
/** Data of a Hall node, with its status overlays. */
export type HallData = {
  kind: 'hall'
  hall: BuilderHall
  paused: boolean
  /** Active Quests of this Hall: the live usage against its member cap. */
  claimed: number
  barred: boolean
  issues: string[]
}
/** Data of a Captain node. */
export type CaptainData = {
  kind: 'captain'
  id: string
  name: string
  hallId: string
  issues: string[]
}
/** Data of a Member node. */
export type MemberData = {
  kind: 'member'
  member: BuilderMember
  hallId: string
  issues: string[]
}
/** Any node of the builder canvas. */
export type BuilderNode =
  | Node<StewardData, 'steward'>
  | Node<HallData, 'hall'>
  | Node<CaptainData, 'captain'>
  | Node<MemberData, 'member'>

/** Status overlays the canvas shows on Halls. */
export interface Overlays {
  pausedHalls: ReadonlySet<string>
  /** Active Quests per Hall id. */
  claimed: ReadonlyMap<string, number>
  barred: boolean
}

/** Width of one Hall column, in canvas units. */
export const HALL_WIDTH = 220
const GAP = 40
const ROW = 76
const HALL_TOP = 130

/** The id of the Steward node. */
export const STEWARD_NODE = 'steward'

/**
 * Maps validation issues onto the node they name: a Hall field marks the Hall, a `captain` path
 * the Captain, a `members` path that Member. Issues elsewhere in the document map to no node.
 */
export function issuesByNode(config: BuilderConfig, issues: ConfigIssue[]): Map<string, string[]> {
  const found = new Map<string, string[]>()
  for (const issue of issues) {
    const [root, i, part, j] = issue.path
    const hall = root === 'halls' && typeof i === 'number' ? config.halls[i] : undefined
    if (!hall) {
      continue
    }
    const id =
      part === 'members' && typeof j === 'number'
        ? hall.members[j]?.id
        : part === 'captain'
          ? hall.captain?.id
          : hall.id
    if (id !== undefined) {
      found.set(id, [...(found.get(id) ?? []), issue.message])
    }
  }
  return found
}

/**
 * Lays the config out as a hierarchy: the Steward on top, one tall column per Hall below it, the
 * Captain and Members stacked inside the column. Positions are derived, never stored in config.
 */
export function buildGraph(
  config: BuilderConfig,
  overlays: Overlays,
  issues: ReadonlyMap<string, string[]>
): { nodes: BuilderNode[]; edges: Edge[] } {
  const nodes: BuilderNode[] = []
  const edges: Edge[] = []
  const total = config.halls.length * (HALL_WIDTH + GAP) - GAP
  nodes.push({
    id: STEWARD_NODE,
    type: 'steward',
    position: { x: Math.max(0, total / 2 - HALL_WIDTH / 2), y: 0 },
    width: HALL_WIDTH,
    height: 60,
    draggable: false,
    data: { kind: 'steward', name: config.steward.name },
  })
  config.halls.forEach((hall, i) => {
    const x = i * (HALL_WIDTH + GAP)
    const rows = 1 + hall.members.length
    nodes.push({
      id: hall.id,
      type: 'hall',
      position: { x, y: HALL_TOP },
      width: HALL_WIDTH,
      height: 70 + rows * ROW + 12,
      draggable: false,
      zIndex: 0,
      data: {
        kind: 'hall',
        hall,
        paused: overlays.pausedHalls.has(hall.id),
        claimed: overlays.claimed.get(hall.id) ?? 0,
        barred: overlays.barred,
        issues: issues.get(hall.id) ?? [],
      },
    })
    edges.push({ id: `e-${hall.id}`, source: STEWARD_NODE, target: hall.id })
    if (hall.captain) {
      nodes.push({
        id: hall.captain.id,
        type: 'captain',
        position: { x: x + 12, y: HALL_TOP + 70 },
        width: HALL_WIDTH - 24,
        height: ROW - 12,
        draggable: false,
        zIndex: 1,
        data: {
          kind: 'captain',
          id: hall.captain.id,
          name: hall.captain.name,
          hallId: hall.id,
          issues: issues.get(hall.captain.id) ?? [],
        },
      })
    }
    hall.members.forEach((member, j) => {
      nodes.push({
        id: member.id,
        type: 'member',
        position: { x: x + 12, y: HALL_TOP + 70 + (j + 1) * ROW },
        width: HALL_WIDTH - 24,
        height: ROW - 12,
        draggable: !hall.locked,
        zIndex: 2,
        data: { kind: 'member', member, hallId: hall.id, issues: issues.get(member.id) ?? [] },
      })
    })
  })
  return { nodes, edges }
}
