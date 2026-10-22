import type { Point, Room } from './room'
import type { Spot } from './route'
import type { MapKey } from './world'

/** The spot a Member works at: their own station in their Hall's room (the room spawn if they have none). */
export function memberSpot(room: Room, key: MapKey, memberId: string): Spot {
  const station = room.stations.find((s) => s.memberId === memberId)
  const tile = station?.tile ?? room.spawn
  return { map: key, x: tile.x, y: tile.y }
}

/** Free floor tiles in a Hall room for apprentices to stand on, in order: clear of stations, the entry and the doorway. */
export function apprenticeSeats(room: Room, count: number): Point[] {
  const keep = new Set<string>([
    `${room.spawn.x},${room.spawn.y}`,
    ...room.stations.map((s) => `${s.tile.x},${s.tile.y}`),
    ...room.pois.map((p) => `${p.stand.x},${p.stand.y}`),
    ...room.doorways.map((d) => `${d.tile.x},${d.tile.y}`),
  ])
  const free: Point[] = []
  // Start two rows below the back wall's desks and work down: the middle of the floor.
  for (let y = Math.floor(room.height / 2); y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.walkable(x, y) && !keep.has(`${x},${y}`)) {
        free.push({ x, y })
      }
    }
  }
  const spread = [...free.filter((_p, i) => i % 2 === 0), ...free.filter((_p, i) => i % 2 !== 0)]
  return spread.slice(0, count)
}

/** The tile the Steward stands on (in front of their desk). */
export function stewardStand(room: Room): Point {
  const desk = room.pois.find((p) => p.kind === 'steward-desk')
  return desk ? desk.stand : room.spawn
}
