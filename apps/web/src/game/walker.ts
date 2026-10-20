import type { Anim, Plan } from './behavior'
import type { Leg, Spot, WalkableOf } from './route'
import type { Vec } from './walk'
import type { MapId } from './world'

/** A Member's body in the town: which map, where, and what they are doing. */
export interface Walker {
  map: MapId
  pos: Vec
  facingLeft: boolean
  path: Vec[]
  legs: Leg[]
  planKey: string
  arrived: boolean
  readyAt: number
  hidden: boolean
  anim: Anim
  carry: 'scroll' | null
  line: string | null
  arrivals: number
  handedIn: boolean
}

/** Placeholder. */
export function standing(_spot: Spot, _key: string): Walker {
  throw new Error('not implemented')
}

/** Placeholder. */
export function replan(
  _w: Walker,
  _plan: Plan,
  _now: number,
  _walkableOf: WalkableOf,
  _instant: boolean
): Walker {
  throw new Error('not implemented')
}

/** Placeholder. */
export function stepWalker(
  _w: Walker,
  _seconds: number,
  _now: number,
  _walkableOf: WalkableOf
): Walker {
  throw new Error('not implemented')
}
