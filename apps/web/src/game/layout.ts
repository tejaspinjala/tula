import { z } from 'zod'
import hallMap from './hall.tiled.json'
import { hallMapFor, wingsFor } from './hallmap'

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
  /** The Council chamber: a blocked dais in the corridor where the five elders stand. */
  council: TileRect
  /** The Tiled JSON this layout reads, for the renderer. */
  source: unknown
  /** True when a tile is inside the map and not blocked by the collision layer. */
  walkable: (x: number, y: number) => boolean
}

const property = z.object({ name: z.string(), value: z.union([z.string(), z.number()]) })
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
export function hallLayout(roomCount = 6): HallLayout {
  const source = hallMapFor(hallMap, roomCount)
  const map = tiledMap.parse(source)
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
    slot: z
      .number()
      .catch(0)
      .parse(o.properties?.find((p) => p.name === 'slot')?.value),
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
    council: one('council'),
    source,
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

/** The tile of a room's Quest Board: the top row below the label, near the far corner. */
export function questBoardIn(layout: HallLayout, room: TileRect): { x: number; y: number } {
  const y = room.y + 1
  for (let x = room.x + room.w - 3; x > room.x + 1; x--) {
    if (layout.walkable(x, y)) {
      return { x, y }
    }
  }
  return { x: room.x + room.w - 3, y }
}

/**
 * The tile of a room's mailbox: the top row below the label, near the near corner (the Quest Board
 * keeps the far one), on a walkable tile that is not the board's.
 */
export function mailboxIn(layout: HallLayout, room: TileRect): { x: number; y: number } {
  const y = room.y + 1
  const board = questBoardIn(layout, room)
  for (let x = room.x + 2; x < room.x + room.w - 1; x++) {
    if (layout.walkable(x, y) && !(x === board.x && y === board.y)) {
      return { x, y }
    }
  }
  return { x: room.x + 2, y }
}

/** Distinct walkable tiles where apprentices stand: the row under the work row, from the right. */
export function apprenticeSeats(
  layout: HallLayout,
  room: TileRect,
  count: number
): { x: number; y: number }[] {
  const board = questBoardIn(layout, room)
  const seats: { x: number; y: number }[] = []
  for (const y of [room.y + 3, room.y + 5]) {
    for (let x = room.x + room.w - 2; x > room.x && seats.length < count; x--) {
      if (layout.walkable(x, y) && !(x === board.x && y === board.y)) {
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

/** What the scene draws for one room slot: its label, how dark its veil is, and whether its door is shut. */
export interface RoomTag {
  text: string
  veil: number
  closed: boolean
}

/** The label, veil and door of each of `slots` room slots, from the Halls in roster order. */
export function roomTags(
  halls: readonly { name: string; locked: boolean; paused: boolean }[],
  slots: number
): RoomTag[] {
  return Array.from({ length: Math.max(slots, halls.length) }, (_slot, index): RoomTag => {
    const hall = halls[index]
    if (!hall) {
      return { text: 'Locked room', veil: 0.45, closed: true }
    }
    const text = hall.locked
      ? `${hall.name} (locked)`
      : hall.paused
        ? `${hall.name} (paused)`
        : hall.name
    return {
      text: text.slice(0, 22),
      veil: hall.locked ? 0.6 : hall.paused ? 0.35 : 0,
      closed: hall.locked,
    }
  })
}

/** What a change of roster size means for the drawn hall map. */
export function refitHall(
  drawnSlots: number,
  slots: number,
  viewMap: string,
  followed: string | null
): { redraw: boolean; reframe: boolean } {
  const redraw = wingsFor(slots) !== wingsFor(drawnSlots)
  return { redraw, reframe: redraw && viewMap === 'hall' && followed === null }
}

/** Where the Guild Master stands after the map changed: the same spot if still walkable, else the entrance. */
export function landing(
  at: { x: number; y: number },
  walkable: (x: number, y: number) => boolean,
  entrance: { x: number; y: number }
): { x: number; y: number } {
  return walkable(Math.floor(at.x), Math.floor(at.y)) ? at : { ...entrance }
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

/**
 * Where a speech bubble of `width` px centres horizontally for a speaker at `x`, kept inside the
 * camera `view` (a narrow screen would otherwise clip it at the edge). A bubble wider than the
 * view centres on the view.
 */
export function bubbleCentreX(
  view: { x: number; width: number },
  width: number,
  x: number
): number {
  const half = width / 2 + 1
  if (width + 2 >= view.width) {
    return view.x + view.width / 2
  }
  return Math.min(Math.max(x, view.x + half), view.x + view.width - half)
}
