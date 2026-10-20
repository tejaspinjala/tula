import { z } from 'zod'
import hallMap from './hall.tiled.json'

/** A rectangle in tiles. */
export interface TileRect {
  x: number
  y: number
  w: number
  h: number
}

/** A room slot: the rectangle a Hall's room fills. */
export interface RoomSlot extends TileRect {
  slot: number
}

/** The hall as the Tiled map describes it, in tiles. */
export interface HallLayout {
  width: number
  height: number
  tileSize: number
  rooms: RoomSlot[]
  doorways: RoomSlot[]
  stewardDesk: TileRect
  sealDesk: TileRect
  gate: TileRect
  coins: TileRect
  /** True when a tile is inside the map and not blocked by the collision layer. */
  walkable: (x: number, y: number) => boolean
}

const property = z.object({ name: z.string(), value: z.number() })
const mapObject = z.object({
  name: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  properties: z.array(property).optional(),
})
const layer = z.union([
  z.object({ type: z.literal('tilelayer'), name: z.string(), data: z.array(z.number()) }),
  z.object({ type: z.literal('objectgroup'), name: z.string(), objects: z.array(mapObject) }),
])
const tiledMap = z.object({
  width: z.number(),
  height: z.number(),
  tilewidth: z.number(),
  layers: z.array(layer),
})

/** The `collision` layer of the Tiled map: any tile on it blocks walking. */
const COLLISION_LAYER = 'collision'

/** Reads the Tiled hall map (walls, furniture, rooms, doorways, desks, gate). */
export function hallLayout(): HallLayout {
  const map = tiledMap.parse(hallMap)
  const size = map.tilewidth
  let collision: number[] = []
  const objects: z.infer<typeof mapObject>[] = []
  for (const l of map.layers) {
    if (l.type === 'tilelayer' && l.name === COLLISION_LAYER) {
      collision = l.data
    } else if (l.type === 'objectgroup') {
      objects.push(...l.objects)
    }
  }
  const rect = (o: z.infer<typeof mapObject>): TileRect => ({
    x: o.x / size,
    y: o.y / size,
    w: o.width / size,
    h: o.height / size,
  })
  const slotOf = (o: z.infer<typeof mapObject>): RoomSlot => ({
    ...rect(o),
    slot: o.properties?.find((p) => p.name === 'slot')?.value ?? 0,
  })
  const ofType = (type: string) => objects.filter((o) => o.type === type)
  const one = (type: string): TileRect => {
    const found = ofType(type)[0]
    if (!found) {
      throw new Error(`hall map has no ${type}`)
    }
    return rect(found)
  }
  const bySlot = (a: RoomSlot, b: RoomSlot) => a.slot - b.slot
  return {
    width: map.width,
    height: map.height,
    tileSize: size,
    rooms: ofType('room').map(slotOf).sort(bySlot),
    doorways: ofType('doorway').map(slotOf).sort(bySlot),
    stewardDesk: one('steward-desk'),
    sealDesk: one('seal-desk'),
    gate: one('gate'),
    coins: one('coins'),
    walkable: (x, y) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < map.width &&
      y < map.height &&
      (collision[y * map.width + x] ?? 0) === 0,
  }
}

/** Distinct walkable tiles inside a room, one per Member, so they can later be walked to. */
export function seatsIn(
  layout: HallLayout,
  room: TileRect,
  count: number
): { x: number; y: number }[] {
  const seats: { x: number; y: number }[] = []
  // Seats start below the work row (y+2), clear of the furniture and the doorway.
  for (let y = room.y + 4; y < room.y + room.h - 1 && seats.length < count; y++) {
    for (let x = room.x + 1; x < room.x + room.w - 1 && seats.length < count; x += 3) {
      if (layout.walkable(x, y)) {
        seats.push({ x, y })
      }
    }
  }
  return seats
}

/**
 * The map's walkable test minus the doorways of rooms that are locked or empty: a closed door
 * blocks entry. `rooms` is in slot order; a doorway past its end belongs to an empty room.
 */
export function withClosedDoors(
  layout: HallLayout,
  rooms: readonly { locked: boolean }[]
): (x: number, y: number) => boolean {
  const closed = layout.doorways.filter((_door, index) => rooms[index]?.locked ?? true)
  return (x, y) =>
    layout.walkable(x, y) &&
    !closed.some((door) => x >= door.x && x < door.x + door.w && y >= door.y && y < door.y + door.h)
}

/** The zoom that fills a frame with the hall (to two places), never below a quarter. */
export function fitZoom(frameW: number, frameH: number, worldW: number, worldH: number): number {
  const fill = Math.min(frameW / worldW, frameH / worldH)
  return Math.max(0.25, Math.floor(fill * 100) / 100)
}

/** The zoom the hall opens at: the fit, but never below a readable one. */
export function openZoom(frameW: number, frameH: number, worldW: number, worldH: number): number {
  return Math.max(1, fitZoom(frameW, frameH, worldW, worldH))
}

/** Where a speech bubble centres for a speaker at pixel `(x, y)`: above, unless that covers a room label. */
export function bubbleCentreY(
  rooms: readonly TileRect[],
  tileSize: number,
  x: number,
  y: number
): number {
  const above = y - 26
  // A room's label is a 20px band under its top edge; a 20px bubble above the speaker would cover it.
  const covers = rooms.some((room) => {
    const top = room.y * tileSize
    return (
      x >= room.x * tileSize && x < (room.x + room.w) * tileSize && y > top && above - 10 < top + 20
    )
  })
  return covers ? y + 26 : above
}
