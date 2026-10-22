import { z } from 'zod'
import archiveMap from './archive.tiled.json'
import countingHouseMap from './counting-house.tiled.json'
import hallMap from './hall.tiled.json'
import plazaMap from './plaza.tiled.json'
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

/** A rectangle in tiles. */
interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** A doorway: stepping onto its rectangle moves the Guild Master to `(toX, toY)` of map `to`. */
export interface Door extends Rect {
  to: MapId
  toX: number
  toY: number
}

/** A map as the Tiled JSON describes it, in tiles. */
export interface MapData {
  id: MapId
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

function parse(id: MapId): MapData {
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
      toX: z.number().parse(o.properties.toX),
      toY: z.number().parse(o.properties.toY),
    }))
  return {
    id,
    width: map.width,
    height: map.height,
    tileSize: size,
    doors,
    lanterns: objects.filter((o) => o.type === 'lantern').map((o) => ({ x: o.x, y: o.y })),
    objects,
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

const cache = new Map<MapId, MapData>()

/** The data of one map of the town (parsed once). */
export function mapData(id: MapId): MapData {
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
    return { name, map: 'hall', ...rectOf(o), stand: { x: o.x + 5, y: o.y + 5 } }
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
