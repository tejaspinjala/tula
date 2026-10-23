import { z } from 'zod'
import archiveMap from './archive.tiled.json'
import countingHouseMap from './counting-house.tiled.json'
import hallMap from './hall.tiled.json'
import plazaMap from './plaza.tiled.json'
import {
  greatHall,
  type Point,
  type Room,
  type RoomHall,
  type RoomMember,
  type RoomStyle,
  roomFor,
  styleFor,
} from './room'
import trailMap from './trail.tiled.json'

/** The maps of the guild town: the Guild Hall, the Archive, the Quest Board plaza, the Counting House (the Treasury) and the trail. */
export const MAP_IDS = ['hall', 'plaza', 'archive', 'counting-house', 'trail'] as const

/** One map of the town. */
export type MapId = (typeof MAP_IDS)[number]

/** Map ids that were renamed; a saved last location naming one is mapped once, on read. */
const RENAMED_MAP_IDS: Readonly<Record<string, MapId>> = { vault: 'counting-house' }

/**
 * Reads a saved last-location map id: a current id is kept, a renamed one (`vault`, now the
 * Counting House) is mapped, anything else (or nothing) is `null`.
 */
export function readSavedMapId(saved: string | null): MapId | null {
  if (saved === null) {
    return null
  }
  const known = MAP_IDS.find((id) => id === saved)
  return known ?? RENAMED_MAP_IDS[saved] ?? null
}

/** A Hall's room, keyed by its Hall id (`hall:<id>`). */
export type RoomMapId = `hall:${string}`

/** Any map the Guild Master or a Member can be in: a town map or a Hall's room. */
export type MapKey = MapId | RoomMapId

/** True when a map key names a Hall's room. */
export function isRoomMapId(key: string): key is RoomMapId {
  return key.startsWith('hall:')
}

/** A rectangle in tiles. */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A doorway: stepping onto its rectangle moves the Guild Master to `(toX, toY)` of map `to`. */
export interface Door extends Rect {
  to: MapKey
  toX: number
  toY: number
}

/** A map as the Tiled JSON describes it, in tiles. */
export interface MapData {
  id: MapKey
  width: number
  height: number
  tileSize: number
  doors: Door[]
  /** Points of light at night, one tile each. */
  lanterns: { x: number; y: number }[]
  /** True when a tile is inside the map and not blocked by its collision layer. */
  walkable: (x: number, y: number) => boolean
  /** The Tiled objects by name and type, for the named-place lookup. */
  objects: MapObject[]
  /** Doorways shut for a reason (a locked Hall): not walkable, each with the sign's reason. */
  barred: (Rect & { reason: string })[]
}

/** A Tiled object, in tiles, with its properties. */
export interface MapObject extends Rect {
  name: string
  type: string
  properties: Record<string, string | number>
}

/** The names behaviour code uses to send someone somewhere. */
export const PLACE_NAMES = [
  'seal-desk',
  'steward-desk',
  'treasury-counter',
  'hall-room-0',
  'hall-room-1',
  'hall-room-2',
  'hall-room-3',
  'hall-room-4',
  'hall-room-5',
  'archive-shelves',
  'quest-board',
  'counting-house',
  'trail',
  'wilds',
] as const

/** A place's name. */
export type PlaceName = (typeof PLACE_NAMES)[number]

/** A named place: its map, its rectangle, and a walkable tile to stand on to use it. */
export interface Place extends Rect {
  name: PlaceName
  map: MapId
  stand: { x: number; y: number }
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
const mapId = z.enum(MAP_IDS)

const SOURCES: Record<MapId, unknown> = {
  hall: hallMap,
  plaza: plazaMap,
  archive: archiveMap,
  'counting-house': countingHouseMap,
  trail: trailMap,
}

/** The raw Tiled JSON of a map, for the renderer (validated by `mapData`). */
export function mapSource(id: MapId): unknown {
  return SOURCES[id]
}

/** The Great Hall's seal desk, steward desk and mailbox rectangles, named for the place lookup. */
function greatHallObjects(room: Room): MapObject[] {
  const poi = (kind: string, name: string): MapObject[] =>
    room.pois
      .filter((p) => p.kind === kind)
      .map((p) => ({ name, type: name, ...p.tile, properties: {} }))
  return [
    ...poi('seal-desk', 'seal-desk'),
    ...poi('steward-desk', 'steward-desk'),
    // The Treasury is read at the mailbox side of the hall until the chest has a place of its own.
    ...poi('mailbox', 'treasury-chest'),
    ...Array.from({ length: 6 }, (_v, slot) => ({
      name: `room-${slot}`,
      type: 'room',
      x: 1 + 3 * slot,
      y: 2,
      w: 1,
      h: 1,
      properties: { slot },
    })),
  ]
}

/** The Halls the world is built from: each Hall, its Members and its chosen room style. */
export interface HallSpec {
  hall: RoomHall
  members: RoomMember[]
  style?: RoomStyle | undefined
}

/** The Great Hall and Hall rooms as last set; the town maps never change. */
let great: Room = greatHall([])
let hallRooms = new Map<RoomMapId, Room>()
let roomOrder: RoomMapId[] = []

/**
 * Sets the Halls whose rooms exist: the Great Hall gets a doorway per Hall, and each Hall gets a
 * room sized to its Members. Call again when Halls or their Members change; map data is rebuilt on
 * the next read.
 */
export function setHalls(specs: readonly HallSpec[]): void {
  const halls = specs.map((spec, index) => ({ ...spec.hall, index }))
  great = greatHall(halls)
  hallRooms = new Map()
  roomOrder = []
  specs.forEach((spec, index) => {
    const key: RoomMapId = `hall:${spec.hall.id}`
    const hall = halls[index]
    if (!hall) {
      return
    }
    const style = styleFor({ name: hall.name, kind: hall.kind, roomStyle: spec.style })
    hallRooms.set(key, roomFor(hall, spec.members, style))
    roomOrder.push(key)
  })
  cache.clear()
}

/** The Great Hall as last set by {@link setHalls}. */
export function greatRoom(): Room {
  return great
}

/** A Hall's room (null when no Hall has that id). */
export function hallRoomOf(key: MapKey): Room | null {
  return isRoomMapId(key) ? (hallRooms.get(key) ?? null) : null
}

/** The room keys of every Hall, in config order. */
export function roomKeys(): readonly RoomMapId[] {
  return roomOrder
}

/** Where a Hall's room sits in the one Phaser world, in px: apart from the town maps and each other. */
export function roomOffset(key: RoomMapId): { x: number; y: number } {
  return { x: 0, y: 150_000 + Math.max(0, roomOrder.indexOf(key)) * 4_000 }
}

/** The map key a room's doorway target names: `great-hall` is the `hall` map. */
function keyOf(target: string): MapKey {
  const known = MAP_IDS.find((id) => id === target)
  if (known) {
    return known
  }
  return isRoomMapId(target) ? target : 'hall'
}

/** A Hall room as map data: its one doorway leads back to the Great Hall. */
function parseRoom(key: RoomMapId, room: Room): MapData {
  return {
    id: key,
    width: room.width,
    height: room.height,
    tileSize: room.tileSize,
    doors: room.doorways.flatMap((d) =>
      d.entry ? [{ ...d.tile, to: keyOf(d.target), toX: d.entry.x, toY: d.entry.y }] : []
    ),
    lanterns: room.lights.filter((l) => l.kind !== 'window').map((l) => l.tile),
    objects: [],
    barred: [],
    walkable: room.walkable,
  }
}

/** The hall map is the Great Hall room: its size, its walls, its way out to the plaza and a doorway per Hall. */
function parseHall(): MapData {
  const room = great
  const old = tiledMap.parse(SOURCES.hall)
  const gate = old.layers
    .flatMap((l) => (l.type === 'objectgroup' ? l.objects : []))
    .find(
      (o) => o.type === 'door' && o.properties?.some((p) => p.name === 'to' && p.value === 'plaza')
    )
  const prop = (name: string) =>
    z.number().parse(gate?.properties?.find((p) => p.name === name)?.value)
  const exit = room.doorways.find((d) => d.target === 'plaza')
  const halls: Door[] = []
  const barred: MapData['barred'] = []
  for (const d of room.doorways) {
    const target = isRoomMapId(d.target) ? hallRooms.get(d.target) : undefined
    if (!isRoomMapId(d.target) || !target) {
      continue
    }
    if (d.locked) {
      barred.push({ ...d.tile, reason: `${d.label} is locked. Unlock it from the Hall builder.` })
    } else {
      halls.push({ ...d.tile, to: d.target, toX: target.spawn.x, toY: target.spawn.y })
    }
  }
  const shut = (x: number, y: number) =>
    barred.some((b) => x >= b.x && x < b.x + b.w && y >= b.y && y < b.y + b.h)
  return {
    id: 'hall',
    width: room.width,
    height: room.height,
    tileSize: room.tileSize,
    doors: [
      ...(exit ? [{ ...exit.tile, to: 'plaza' as const, toX: prop('toX'), toY: prop('toY') }] : []),
      ...halls,
    ],
    lanterns: room.lights.filter((l) => l.kind !== 'window').map((l) => l.tile),
    objects: greatHallObjects(room),
    barred,
    walkable: (x, y) => room.walkable(x, y) && !shut(x, y),
  }
}

function parse(id: MapKey): MapData {
  if (id === 'hall') {
    return parseHall()
  }
  if (isRoomMapId(id)) {
    const room = hallRooms.get(id)
    return room ? parseRoom(id, room) : parseHall()
  }
  const map = tiledMap.parse(SOURCES[id])
  const size = map.tilewidth
  let collision: number[] = []
  const objects: MapObject[] = []
  for (const l of map.layers) {
    if (l.type === 'tilelayer' && l.name === 'collision') {
      collision = l.data
    } else if (l.type === 'objectgroup') {
      for (const o of l.objects) {
        objects.push({
          name: o.name,
          type: o.type,
          x: o.x / size,
          y: o.y / size,
          w: o.width / size,
          h: o.height / size,
          properties: Object.fromEntries((o.properties ?? []).map((p) => [p.name, p.value])),
        })
      }
    }
  }
  const doors = objects
    .filter((o) => o.type === 'door')
    .map((o) => ({
      x: o.x,
      y: o.y,
      w: o.w,
      h: o.h,
      to: mapId.parse(o.properties.to),
      // Arriving in the hall puts you at the Great Hall's spawn, inside its plaza doorway.
      toX: o.properties.to === 'hall' ? greatHall([]).spawn.x : z.number().parse(o.properties.toX),
      toY: o.properties.to === 'hall' ? greatHall([]).spawn.y : z.number().parse(o.properties.toY),
    }))
  return {
    id,
    width: map.width,
    height: map.height,
    tileSize: size,
    doors,
    lanterns: objects.filter((o) => o.type === 'lantern').map((o) => ({ x: o.x, y: o.y })),
    objects,
    barred: [],
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

const cache = new Map<MapKey, MapData>()

/** The data of one map of the town (parsed once). */
export function mapData(id: MapKey): MapData {
  const cached = cache.get(id)
  if (cached) {
    return cached
  }
  const data = parse(id)
  cache.set(id, data)
  return data
}

/** The door a tile stands in, if any. */
export function doorAt(map: MapData, x: number, y: number): Door | null {
  return map.doors.find((d) => x >= d.x && x < d.x + d.w && y >= d.y && y < d.y + d.h) ?? null
}

function find(map: MapData, type: string, name?: string): MapObject {
  const found = map.objects.find((o) => o.type === type && (name === undefined || o.name === name))
  if (!found) {
    throw new Error(`map ${map.id} has no ${name ?? type}`)
  }
  return found
}

const rectOf = (o: MapObject): Rect => ({ x: o.x, y: o.y, w: o.w, h: o.h })

/**
 * A named place: where it is, and a walkable tile to stand on to use it. A pure lookup over the
 * map data, so behaviour code (and the Guild Master's destinations) never hard-code coordinates.
 */
export function placeNamed(name: PlaceName): Place {
  const hall = mapData('hall')
  const below = (o: MapObject) => ({ x: o.x, y: o.y + o.h })
  const tagged = (map: MapId, objectName: string): Place => {
    const o = find(mapData(map), 'place', objectName)
    return {
      name,
      map,
      ...rectOf(o),
      stand: { x: z.number().parse(o.properties.standX), y: z.number().parse(o.properties.standY) },
    }
  }
  const room = /^hall-room-(\d)$/.exec(name)
  if (room) {
    const slot = Number(room[1])
    const o = hall.objects.find(
      (candidate) => candidate.type === 'room' && candidate.properties.slot === slot
    )
    if (!o) {
      throw new Error(`hall has no room ${slot}`)
    }
    return { name, map: 'hall', ...rectOf(o), stand: { x: o.x, y: o.y + 1 } }
  }
  switch (name) {
    case 'seal-desk': {
      const o = find(hall, 'seal-desk')
      return { name, map: 'hall', ...rectOf(o), stand: below(o) }
    }
    case 'steward-desk': {
      const o = find(hall, 'steward-desk')
      return { name, map: 'hall', ...rectOf(o), stand: below(o) }
    }
    case 'treasury-counter': {
      const o = find(hall, 'treasury-chest')
      return { name, map: 'hall', ...rectOf(o), stand: below(o) }
    }
    case 'archive-shelves':
      return tagged('archive', name)
    case 'quest-board':
      return tagged('plaza', name)
    case 'counting-house':
      return tagged('counting-house', name)
    case 'trail':
      return tagged('plaza', name)
    case 'wilds':
      return tagged('trail', name)
    default:
      throw new Error(`no place named ${name}`)
  }
}

/** What stepping through a doorway does: arrive in another map, or find it barred. */
export type Step = { kind: 'go'; to: MapKey; at: Point; facing: 'up' | 'down' }

/**
 * Where the Guild Master goes on stepping onto a tile of a map: through the doorway there to its
 * entry, facing in (up into a Hall room, down into the Great Hall), or nowhere. Pure.
 */
export function stepThrough(from: MapKey, tile: Point): Step | null {
  const door = doorAt(mapData(from), tile.x, tile.y)
  if (!door) {
    return null
  }
  return {
    kind: 'go',
    to: door.to,
    at: { x: door.toX, y: door.toY },
    facing: isRoomMapId(door.to) ? 'up' : 'down',
  }
}

/** The reason a barred doorway on the tile or beside it is shut (the sign's reason), or null. */
export function barrierNear(from: MapKey, tile: Point): string | null {
  const near = (b: Rect) =>
    Math.abs(b.x - tile.x) + Math.abs(b.y - tile.y) <= 1 ||
    (tile.x >= b.x && tile.x < b.x + b.w && tile.y >= b.y && tile.y < b.y + b.h)
  return mapData(from).barred.find(near)?.reason ?? null
}

/**
 * The tile the Guild Master appears on when a map is opened directly (a saved room): the Great
 * Hall's spawn, a Hall room's spawn, or where the doorway into a town map lands. Null when no open
 * doorway leads there (a locked or removed Hall), so the caller falls back to the Great Hall.
 */
export function landingFor(key: MapKey): Point | null {
  if (key === 'hall') {
    return { x: great.spawn.x, y: great.spawn.y }
  }
  const maps: MapKey[] = [...MAP_IDS, ...roomOrder]
  for (const from of maps) {
    const door = mapData(from).doors.find((d) => d.to === key)
    if (door) {
      return { x: door.toX, y: door.toY }
    }
  }
  return null
}
