import type { Anim, Plan, Stop } from './behavior'
import { type Leg, routeBetween, type Spot, type WalkableOf } from './route'
import { followPath, type Vec } from './walk'
import type { MapId } from './world'

/** How fast a Member walks about the town, in tiles per second (a Member strolls; the Guild Master runs). */
export const STROLL = 3.5

/** A Member's body in the town: which map, where, and what they are doing. Plain data, no engine objects. */
export interface Walker {
  /** The map of the town the Member is in (tracked even when the camera is elsewhere). */
  map: MapId
  /** Position in tiles, tile `(x, y)` centred at `(x + 0.5, y + 0.5)`. */
  pos: Vec
  facingLeft: boolean
  /** Tiles still to walk in this map. */
  path: Vec[]
  /** Legs still to walk after `path`, one per further map. */
  legs: Leg[]
  /** Stops still to visit; the first is the one being walked to or done. */
  queue: Stop[]
  /** The key of the plan being followed. */
  planKey: string
  /** True once the first stop of the queue is reached. */
  arrived: boolean
  /** When the dwell at the current stop is over, in ms. */
  readyAt: number
  /** True while out of sight (gone to the Wilds). */
  hidden: boolean
  anim: Anim
  carry: 'scroll' | null
  /** The line said at the latest arrival, if any. */
  line: string | null
  /** How many stops have been arrived at: a new count is a new arrival (a line is said once). */
  arrivals: number
  /** True once a hand-in stop has run its course. */
  handedIn: boolean
}

const centre = (spot: Vec): Vec => ({ x: spot.x + 0.5, y: spot.y + 0.5 })

/** A Member standing still at a spot. */
export function standing(spot: Spot, key: string): Walker {
  return {
    map: spot.map,
    pos: centre(spot),
    facingLeft: false,
    path: [],
    legs: [],
    queue: [],
    planKey: key,
    arrived: true,
    readyAt: 0,
    hidden: false,
    anim: 'idle',
    carry: null,
    line: null,
    arrivals: 0,
    handedIn: false,
  }
}

const spotOf = (w: Walker): Spot => ({ map: w.map, x: Math.floor(w.pos.x), y: Math.floor(w.pos.y) })

/** Arrives at the first stop of the queue: its animation, visibility, scroll and line take hold. */
function arrive(w: Walker, now: number): Walker {
  const stop = w.queue[0]
  if (!stop) {
    return { ...w, arrived: true }
  }
  return {
    ...w,
    path: [],
    legs: [],
    arrived: true,
    readyAt: now + stop.dwellMs,
    hidden: stop.hidden,
    anim: stop.anim,
    carry: stop.carry ?? (stop.anim === 'handin' ? w.carry : null),
    line: stop.line,
    arrivals: w.arrivals + 1,
  }
}

/** Starts walking to the first stop of the queue; an unreachable one is a teleport. */
function head(w: Walker, now: number, walkableOf: WalkableOf): Walker {
  const stop = w.queue[0]
  if (!stop) {
    return { ...w, arrived: true }
  }
  const legs = routeBetween(spotOf(w), stop.spot, walkableOf)
  if (!legs) {
    return arrive({ ...w, map: stop.spot.map, pos: centre(stop.spot) }, now)
  }
  return { ...w, legs, path: [], arrived: false, hidden: false }
}

/**
 * Follows a plan: walks to its first stop, or (instant: reduced motion, the first draw) puts the
 * Member at the last stop at once. Pure.
 */
export function replan(
  w: Walker,
  plan: Plan,
  now: number,
  walkableOf: WalkableOf,
  instant: boolean
): Walker {
  const last = plan.stops.at(-1)
  const queue = instant && last ? [last] : plan.stops
  const next = { ...w, queue, planKey: plan.key, handedIn: false }
  if (instant && last) {
    return arrive({ ...next, map: last.spot.map, pos: centre(last.spot) }, now)
  }
  return head(next, now, walkableOf)
}

/** Advances a Member by one frame: along the path, through a door to the next map, or through the dwell to the next stop. Pure. */
export function stepWalker(
  w: Walker,
  seconds: number,
  now: number,
  walkableOf: WalkableOf
): Walker {
  if (w.path.length > 0) {
    const moved = followPath(w.pos, w.path, STROLL * seconds)
    return {
      ...w,
      pos: moved.pos,
      path: moved.path,
      facingLeft: moved.pos.x === w.pos.x ? w.facingLeft : moved.pos.x < w.pos.x,
    }
  }
  const leg = w.legs[0]
  if (leg) {
    return { ...w, map: leg.map, pos: centre(leg.start), path: leg.path, legs: w.legs.slice(1) }
  }
  if (!w.arrived) {
    return arrive(w, now)
  }
  if (w.queue.length > 1 && now >= w.readyAt) {
    const done = w.queue[0]
    return head(
      { ...w, queue: w.queue.slice(1), handedIn: w.handedIn || done?.anim === 'handin' },
      now,
      walkableOf
    )
  }
  return w
}
