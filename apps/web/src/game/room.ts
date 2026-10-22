/**
 * The pure room model of the three-quarter Guildhall (ADR-0016): rooms read from the generated Tiled
 * templates, with a station per Member, doorways, collision, depth bands, lights and map POIs. No Phaser.
 */

/** The room styles a Hall can be furnished in. */
export const ROOM_STYLES = [
  'writing-room',
  'library',
  'workshop',
  'studio',
  'infirmary',
  'garden-room',
  'quiet-room',
] as const
/** A Hall room style. */
export type RoomStyle = (typeof ROOM_STYLES)[number]
/** The template size a room uses: up to 4, 8 or 12 stations. */
export type RoomSize = 'S' | 'M' | 'L'

/** A tile position. */
export interface Point {
  x: number
  y: number
}
/** A rectangle in tiles. */
export interface Rect extends Point {
  w: number
  h: number
}
/** Which way a Member at a station faces. */
export type Facing = 'up' | 'down' | 'left' | 'right'

/** The parts of a Hall the room model reads. */
export interface RoomHall {
  id: string
  name: string
  kind: 'work' | 'private'
  locked: boolean
  /** Position in config order; picks the doorway in the Great Hall. */
  index?: number
}
/** A Member of the Hall; the Captain sits at the head desk. */
export interface RoomMember {
  id: string
  captain?: boolean
}
/** Where one Member works. */
export interface Station {
  memberId: string
  /** The tile the Member stands on. */
  tile: Point
  facing: Facing
  /** The desk footprint (null for stations past the template's desks). */
  desk: Rect | null
  captain: boolean
}
/** A piece of furniture: a footprint, with a top layer drawn above characters when it has one. */
export interface Furniture {
  frame: string
  tile: Rect
  top: boolean
  /** The y-sort key: the footprint's bottom edge in tiles. */
  depth: number
  /** True for pieces taller than a tile, drawn over a Member walking behind them. */
  tall: boolean
}
/** A way into another room or map. */
export interface Doorway {
  tile: Rect
  /** The room id (`great-hall`, `hall:<id>`) or town map (`plaza`) it leads to. */
  target: string
  /** Where the Guild Master appears in the target. */
  entry: Point
  /** The Hall the doorway belongs to, in the Great Hall. */
  hallId?: string
  locked: boolean
  label: string
}
/** A light: a window patch by day, a lamp pool by night. */
export interface Light {
  kind: 'window' | 'sconce' | 'lamp'
  tile: Point
  radius: number
}
/** A landmark for the Guild Map. */
export interface Poi {
  kind: 'steward-desk' | 'seal-desk' | 'quest-board' | 'mailbox' | 'gate'
  tile: Rect
  /** The tile a Member waits on, or the Guild Master stands on to use it. */
  stand: Point
}
/** Tile layers by frame name, row-major, `null` where empty. */
export interface RoomLayers {
  floor: (string | null)[]
  wallFace: (string | null)[]
  wallTop: (string | null)[]
  decor: (string | null)[]
}
/** Depth bands of the world layers; characters sort between by their feet row. */
export const DEPTH = { floor: 0, wall: 10, shadow: 20, actor: 100, top: 10_000 } as const

/** One room of the Guildhall. */
export interface Room {
  id: string
  style: RoomStyle | 'great-hall'
  size: RoomSize | 'great'
  width: number
  height: number
  tileSize: number
  layers: RoomLayers
  furniture: Furniture[]
  stations: Station[]
  doorways: Doorway[]
  /** Row-major; true where walking is blocked. */
  collision: boolean[]
  lights: Light[]
  pois: Poi[]
  /** Where the Guild Master appears when entering without a doorway entry. */
  spawn: Point
  /** True when a tile is inside the room and not blocked. */
  walkable: (x: number, y: number) => boolean
}

/** The room for a Hall: the smallest template that holds a station per Member. */
export function roomFor(_hall: RoomHall, _members: readonly RoomMember[], _style: RoomStyle): Room {
  throw new Error('not implemented')
}

/** The Great Hall with a doorway per Hall in config order, and a corridor past six. */
export function greatHall(_halls: readonly RoomHall[]): Room {
  throw new Error('not implemented')
}

/** The room style a Hall gets without a choice: by kind, then name keywords, then workshop. */
export function defaultStyle(_hall: { name: string; kind: 'work' | 'private' }): RoomStyle {
  throw new Error('not implemented')
}
