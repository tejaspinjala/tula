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

/** Moves a hitbox by `(dx, dy)`, one axis at a time so it slides along walls. Not implemented. */
export function moveBy(pos: Vec, dx: number, dy: number, walkable: Walkable): Vec {
  void dx
  void dy
  void walkable
  return pos
}

/** A unit (or zero) direction from held keys. Not implemented. */
export function direction(keys: Keys): Vec {
  void keys
  return { x: 0, y: 0 }
}

/** A direction from a thumb drag of `(dx, dy)` pixels on a stick of `radius`. Not implemented. */
export function stick(dx: number, dy: number, radius: number): Vec {
  void dx
  void dy
  void radius
  return { x: 0, y: 0 }
}

/** The tile path from one tile to another (breadth-first, 4-way), or null. Not implemented. */
export function findPath(walkable: Walkable, from: Vec, to: Vec): Vec[] | null {
  void walkable
  void from
  void to
  return null
}

/** Advances along a tile path by `distance` tiles. Not implemented. */
export function followPath(
  pos: Vec,
  path: readonly Vec[],
  distance: number
): { pos: Vec; path: Vec[] } {
  void distance
  return { pos, path: [...path] }
}

/** The index of the room rectangle holding a position, or null in the corridors. Not implemented. */
export function roomAt(
  rooms: readonly { x: number; y: number; w: number; h: number }[],
  pos: Vec
): number | null {
  void rooms
  void pos
  return null
}
