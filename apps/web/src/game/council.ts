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

const POSE: Record<CouncilState, readonly string[]> = {
  idle: ['rest', 'rest', 'rest'],
  conferring: ['speak', 'lean', 'lean'],
  halted: ['halt', 'halt', 'halt'],
}

/** Tiles the elders occupy, which are solid floor: two behind the table, one at its west end. */
export function elderTiles(table: TableTile): Point[] {
  return [
    { x: table.x, y: table.y - 1 },
    { x: table.x + table.w - 1, y: table.y - 1 },
    { x: table.x - 1, y: table.y },
  ]
}

/** The elders of a Council whose table fills `table`, posed for `state`. */
export function elderPoses(table: TableTile, state: CouncilState): Elder[] {
  return elderTiles(table).map((tile, i) => ({ tile, frame: `elder-${POSE[state][i]}-${i}` }))
}
