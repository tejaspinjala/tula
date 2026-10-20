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

const NONE: TileRect = { x: 0, y: 0, w: 0, h: 0 }

/** Reads the Tiled hall map (walls, furniture, rooms, doorways, desks, gate). */
export function hallLayout(): HallLayout {
  return {
    width: 0,
    height: 0,
    tileSize: 16,
    rooms: [],
    doorways: [],
    stewardDesk: NONE,
    sealDesk: NONE,
    gate: NONE,
    coins: NONE,
    walkable: () => false,
  }
}

/** Distinct walkable tiles inside a room, one per Member, so they can later be walked to. */
export function seatsIn(
  _layout: HallLayout,
  _room: TileRect,
  _count: number
): { x: number; y: number }[] {
  return []
}
