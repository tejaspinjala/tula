import type { Point, Room } from './room'

/** The tiles Members stand on in the Great Hall, in order: open floor clear of every stand and doorway. */
export function memberSeats(_room: Room, _count: number): Point[] {
  throw new Error('todo')
}

/** The tile the Steward stands on (in front of their desk). */
export function stewardStand(_room: Room): Point {
  throw new Error('todo')
}
