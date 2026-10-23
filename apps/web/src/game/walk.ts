/** A position or direction in tile units (tile `(tx, ty)` spans `[tx, tx + 1)`). */
export interface Vec {
  x: number
  y: number
}

/** True when a whole tile may be stood on. */
export type Walkable = (x: number, y: number) => boolean

/** Walking speed, in tiles per second. */
export const SPEED = 6

/** Half the width of the character's hitbox, in tiles. */
export const HALF = 0.3

/** Held direction keys. */
export interface Keys {
  left: boolean
  right: boolean
  up: boolean
  down: boolean
}

const EDGE = 1e-6

/** True when the hitbox centred at `(x, y)` overlaps no blocked tile. */
function clear(x: number, y: number, walkable: Walkable): boolean {
  // Touching a tile edge is not overlapping it.
  for (let tx = Math.floor(x - HALF + EDGE); tx <= Math.floor(x + HALF - EDGE); tx++) {
    for (let ty = Math.floor(y - HALF + EDGE); ty <= Math.floor(y + HALF - EDGE); ty++) {
      if (!walkable(tx, ty)) {
        return false
      }
    }
  }
  return true
}

/** Slides along one axis as far as the hitbox stays clear (flush against a wall). */
function slide(pos: Vec, axis: 'x' | 'y', delta: number, walkable: Walkable): number {
  const from = pos[axis]
  const probe = (v: number) =>
    axis === 'x' ? clear(v, pos.y, walkable) : clear(pos.x, v, walkable)
  if (delta === 0 || probe(from + delta)) {
    return from + delta
  }
  const sign = Math.sign(delta)
  // The wall edge nearest in the direction of travel, minus the hitbox.
  const edge = sign > 0 ? Math.floor(from + HALF) + 1 - HALF : Math.ceil(from - HALF) - 1 + HALF
  const stop = sign > 0 ? Math.min(edge, from + delta) : Math.max(edge, from + delta)
  return probe(stop) ? stop : from
}

/** Longest single move checked at once, so a big step cannot jump over a thin wall. */
const MAX_STEP = 0.25

/** Moves a hitbox by `(dx, dy)`, one axis at a time so it slides along walls. */
export function moveBy(pos: Vec, dx: number, dy: number, walkable: Walkable): Vec {
  const parts = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / MAX_STEP))
  let at = pos
  for (let i = 0; i < parts; i++) {
    const x = slide(at, 'x', dx / parts, walkable)
    const y = slide({ x, y: at.y }, 'y', dy / parts, walkable)
    at = { x, y }
  }
  return at
}

/** A unit (or zero) direction from held keys. */
export function direction(keys: Keys): Vec {
  const x = Number(keys.right) - Number(keys.left)
  const y = Number(keys.down) - Number(keys.up)
  const length = Math.hypot(x, y)
  return length === 0 ? { x: 0, y: 0 } : { x: x / length, y: y / length }
}

/** Fraction of the stick radius that counts as no input. */
const DEAD_ZONE = 0.2

/** A direction from a thumb drag of `(dx, dy)` pixels on a stick of `radius`. */
export function stick(dx: number, dy: number, radius: number): Vec {
  const length = Math.hypot(dx, dy)
  const strength = Math.min(1, length / radius)
  if (strength < DEAD_ZONE) {
    return { x: 0, y: 0 }
  }
  return { x: (dx / length) * strength, y: (dy / length) * strength }
}

const STEPS = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
]

/** The tile path from one tile to another (breadth-first, 4-way), or null. */
export function findPath(walkable: Walkable, from: Vec, to: Vec): Vec[] | null {
  if (!walkable(to.x, to.y) || !walkable(from.x, from.y)) {
    return null
  }
  const key = (v: Vec) => `${v.x},${v.y}`
  const before = new Map<string, Vec | null>([[key(from), null]])
  const queue: Vec[] = [from]
  for (let head = 0; head < queue.length; head++) {
    const here = queue[head]
    if (!here) {
      break
    }
    if (here.x === to.x && here.y === to.y) {
      const path: Vec[] = []
      for (let at: Vec | null | undefined = here; at; at = before.get(key(at))) {
        if (before.get(key(at)) !== null) {
          path.unshift(at)
        }
      }
      return path
    }
    for (const step of STEPS) {
      const next = { x: here.x + step.x, y: here.y + step.y }
      if (!before.has(key(next)) && walkable(next.x, next.y)) {
        before.set(key(next), here)
        queue.push(next)
      }
    }
  }
  return null
}

/** Advances along a tile path by `distance` tiles, aiming at each tile's centre. */
export function followPath(
  pos: Vec,
  path: readonly Vec[],
  distance: number
): { pos: Vec; path: Vec[] } {
  let at = pos
  let left = distance
  const rest = [...path]
  while (rest.length > 0 && left > 0) {
    const next = rest[0]
    if (!next) {
      break
    }
    const tx = next.x + 0.5
    const ty = next.y + 0.5
    const gap = Math.hypot(tx - at.x, ty - at.y)
    if (gap <= left) {
      at = { x: tx, y: ty }
      left -= gap
      rest.shift()
    } else {
      at = { x: at.x + ((tx - at.x) / gap) * left, y: at.y + ((ty - at.y) / gap) * left }
      left = 0
    }
  }
  return { pos: at, path: rest }
}

/** A Hall's name as a title: "Research" is "Research Hall", "Heralds Hall" stays as it is. */
export function hallTitle(name: string): string {
  const trimmed = name.trim()
  return /\bhall$/i.test(trimmed) ? trimmed : `${trimmed} Hall`
}
