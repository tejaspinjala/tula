import { findPath, type Vec, type Walkable } from './walk'
import { type Door, MAP_IDS, type MapId, mapData } from './world'

/** A tile on a map of the town. */
export interface Spot {
  map: MapId
  x: number
  y: number
}

/** One stretch of a route inside a single map: where it starts and the tiles walked after that. */
export interface Leg {
  map: MapId
  start: Vec
  path: Vec[]
}

/** The walkable test of a map (the hall's has the closed doors of locked rooms shut). */
export type WalkableOf = (map: MapId) => Walkable

const defaultWalkable: WalkableOf = (map) => mapData(map).walkable

/** The doors of `from` that lead straight to `to`. */
function doorsTo(from: MapId, to: MapId): Door[] {
  return mapData(from).doors.filter((d) => d.to === to)
}

/** The maps to cross to get from one map to another (breadth-first over doors), or null. */
function mapsBetween(from: MapId, to: MapId): MapId[] | null {
  const before = new Map<MapId, MapId | null>([[from, null]])
  const queue: MapId[] = [from]
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head]
    if (here === undefined) {
      break
    }
    if (here === to) {
      const chain: MapId[] = []
      for (let at: MapId | null | undefined = here; at; at = before.get(at)) {
        chain.unshift(at)
      }
      return chain
    }
    for (const next of MAP_IDS) {
      if (!before.has(next) && doorsTo(here, next).length > 0) {
        before.set(next, here)
        queue.push(next)
      }
    }
  }
  return null
}

/** The shortest walk from `from` into any tile of any of `doors`, or null. */
function toDoor(
  walkable: Walkable,
  from: Vec,
  doors: readonly Door[]
): { path: Vec[]; door: Door } | null {
  let best: { path: Vec[]; door: Door } | null = null
  for (const door of doors) {
    for (let y = door.y; y < door.y + door.h; y++) {
      for (let x = door.x; x < door.x + door.w; x++) {
        const path = from.x === x && from.y === y ? [] : findPath(walkable, from, { x, y })
        if (path && (best === null || path.length < best.path.length)) {
          best = { path, door }
        }
      }
    }
  }
  return best
}

/**
 * The walk from one spot to another, across maps: one leg per map, each but the last ending in a
 * door and the next starting on that door's far side. Pure and deterministic; null when the target
 * cannot be reached (a closed room, a wall).
 */
export function routeBetween(
  from: Spot,
  to: Spot,
  walkableOf: WalkableOf = defaultWalkable
): Leg[] | null {
  const maps = mapsBetween(from.map, to.map)
  if (!maps) {
    return null
  }
  const legs: Leg[] = []
  let at: Vec = { x: from.x, y: from.y }
  for (const [i, map] of maps.entries()) {
    const walkable = walkableOf(map)
    const next = maps[i + 1]
    if (next === undefined) {
      const path = at.x === to.x && at.y === to.y ? [] : findPath(walkable, at, to)
      if (!path) {
        return null
      }
      legs.push({ map, start: at, path })
      break
    }
    const exit = toDoor(walkable, at, doorsTo(map, next))
    if (!exit) {
      return null
    }
    legs.push({ map, start: at, path: exit.path })
    at = { x: exit.door.toX, y: exit.door.toY }
  }
  return legs
}
