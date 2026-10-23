/**
 * The Council of Elders at their table in the Great Hall: where each elder sits and which pose they
 * hold for the Council's state. Pure; the scene only places the frames this returns.
 */
import type { Point } from './room'

/** The Council's state as the scene knows it. */
export type CouncilState = 'idle' | 'conferring' | 'halted'

/** A table footprint in tiles. */
export interface TableTile {
  x: number
  y: number
  w: number
  h: number
}

/** One elder to draw: the tile they sit or stand on and the atlas frame of their pose. */
export interface Elder {
  tile: Point
  frame: string
}

/** The elders of a Council whose table fills `table`, posed for `state`. */
export function elderPoses(_table: TableTile, _state: CouncilState): Elder[] {
  return []
}

/** Tiles the elders occupy, which are solid floor. */
export function elderTiles(_table: TableTile): Point[] {
  return []
}
