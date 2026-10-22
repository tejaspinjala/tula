import type { Point, Room } from './room'

/** The row of floor tiles in front of the back wall's doorways; Members keep clear of it. */
const DOOR_ROW = 3

/** The tiles Members stand on in the Great Hall, in order: open floor clear of every stand and doorway. */
export function memberSeats(room: Room, count: number): Point[] {
  const keep = new Set<string>([
    `${room.spawn.x},${room.spawn.y}`,
    ...room.pois.map((p) => `${p.stand.x},${p.stand.y}`),
    ...room.doorways.map(
      (d) => `${d.tile.x},${d.tile.y > room.height / 2 ? d.tile.y - 1 : d.tile.y + 1}`
    ),
  ])
  const free: Point[] = []
  for (let y = DOOR_ROW + 1; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.walkable(x, y) && !keep.has(`${x},${y}`)) {
        free.push({ x, y })
      }
    }
  }
  // Spread out: every third tile first, so Members do not crowd one another or a wall.
  const spread = [...free.filter((_p, i) => i % 3 === 0), ...free.filter((_p, i) => i % 3 !== 0)]
  return spread.slice(0, count)
}

/** The tile the Steward stands on (in front of their desk). */
export function stewardStand(room: Room): Point {
  const desk = room.pois.find((p) => p.kind === 'steward-desk')
  return desk ? desk.stand : room.spawn
}
