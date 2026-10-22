/**
 * The pure room model of the three-quarter Guildhall (ADR-0016): rooms read from the generated Tiled
 * templates, with a station per Member, doorways, collision, depth bands, lights and map POIs. No Phaser.
 */
import { z } from 'zod'
import templates from './roomtemplates.tiled.json'

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
  /** Where the Guild Master appears in the target; null means the target's own spawn. */
  entry: Point | null
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

const property = z.looseObject({
  name: z.string(),
  value: z.union([z.string(), z.number(), z.boolean()]),
})
const mapObject = z.looseObject({
  name: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  properties: z.array(property).optional(),
})
type MapObject = z.infer<typeof mapObject>
const tiledMap = z.looseObject({
  width: z.number(),
  height: z.number(),
  tilewidth: z.number(),
  tilesets: z.array(
    z.looseObject({ tiles: z.array(z.looseObject({ id: z.number(), type: z.string() })) })
  ),
  layers: z.array(
    z.union([
      z.looseObject({ type: z.literal('tilelayer'), name: z.string(), data: z.array(z.number()) }),
      z.looseObject({
        type: z.literal('objectgroup'),
        name: z.string(),
        objects: z.array(mapObject),
      }),
    ])
  ),
})
const bundle = z.looseObject({ templates: z.record(z.string(), tiledMap) })

/** A template as plain, copyable tiles and objects. */
interface Template {
  width: number
  height: number
  tileSize: number
  layers: RoomLayers
  collision: boolean[]
  objects: MapObject[]
}

function readTemplate(name: string): Template {
  const map = bundle.parse(templates).templates[name]
  if (!map) {
    throw new Error(`no room template ${name}`)
  }
  const frames = new Map<number, string>()
  for (const set of map.tilesets) {
    for (const tile of set.tiles) {
      frames.set(tile.id + 1, tile.type)
    }
  }
  const cells = (layer: string): (string | null)[] => {
    const found = map.layers.find((l) => l.type === 'tilelayer' && l.name === layer)
    return found?.type === 'tilelayer' ? found.data.map((g) => frames.get(g) ?? null) : []
  }
  const found = map.layers.find((l) => l.type === 'tilelayer' && l.name === 'collision')
  return {
    width: map.width,
    height: map.height,
    tileSize: map.tilewidth,
    layers: {
      floor: cells('floor'),
      wallFace: cells('wall-face'),
      wallTop: cells('wall-top'),
      decor: cells('decor'),
    },
    collision: found?.type === 'tilelayer' ? found.data.map((g) => g !== 0) : [],
    objects: map.layers.flatMap((l) => (l.type === 'objectgroup' ? l.objects : [])),
  }
}

const prop = (o: MapObject, name: string): string | number | boolean | undefined =>
  o.properties?.find((p) => p.name === name)?.value
const num = (o: MapObject, name: string): number => z.number().catch(0).parse(prop(o, name))
const tileRect = (o: MapObject, size: number): Rect => ({
  x: o.x / size,
  y: o.y / size,
  w: o.width / size,
  h: o.height / size,
})

const poiKind = z.enum(['steward-desk', 'seal-desk', 'quest-board', 'mailbox', 'gate'])

/** Doorways the Great Hall template draws on its back wall before a corridor is added. */
const TEMPLATE_DOORS = 6
/** Stations the largest template holds. */
const LARGEST_TEMPLATE = 12

function sizeFor(stations: number): RoomSize {
  return stations <= 4 ? 'S' : stations <= 8 ? 'M' : 'L'
}

/** Reads the furniture, lights, POIs and collision every room shares from a template. */
function assemble(
  id: string,
  style: Room['style'],
  size: Room['size'],
  t: Template
): Omit<Room, 'stations' | 'doorways'> & { objects: MapObject[] } {
  const furniture: Furniture[] = t.objects
    .filter((o) => o.type === 'furniture')
    .map((o) => {
      const tile = tileRect(o, t.tileSize)
      const top = prop(o, 'top') === true
      return { frame: o.name, tile, top, depth: tile.y + tile.h, tall: top }
    })
  const lights: Light[] = []
  t.layers.decor.forEach((frame, i) => {
    const tile = { x: i % t.width, y: Math.floor(i / t.width) }
    if (frame === 'window') {
      lights.push({ kind: 'window', tile, radius: 3 })
    } else if (frame === 'sconce') {
      lights.push({ kind: 'sconce', tile, radius: 2 })
    }
  })
  for (const f of furniture) {
    if (f.frame === 'lamp-floor') {
      lights.push({ kind: 'lamp', tile: { x: f.tile.x, y: f.tile.y }, radius: 3 })
    }
  }
  const pois: Poi[] = t.objects.flatMap((o) => {
    const kind = o.type === 'poi' ? poiKind.safeParse(o.name) : null
    return kind?.success
      ? [
          {
            kind: kind.data,
            tile: tileRect(o, t.tileSize),
            stand: { x: num(o, 'standX'), y: num(o, 'standY') },
          },
        ]
      : []
  })
  const spawnObject = t.objects.find((o) => o.type === 'spawn')
  const spawn = spawnObject ? tileRect(spawnObject, t.tileSize) : { x: 1, y: 3 }
  const collision = t.collision
  return {
    id,
    style,
    size,
    width: t.width,
    height: t.height,
    tileSize: t.tileSize,
    layers: t.layers,
    furniture,
    collision,
    lights,
    pois,
    spawn: { x: spawn.x, y: spawn.y },
    objects: t.objects,
    walkable: (x, y) =>
      Number.isInteger(x) &&
      Number.isInteger(y) &&
      x >= 0 &&
      y >= 0 &&
      x < t.width &&
      y < t.height &&
      collision[y * t.width + x] === false,
  }
}

/** The back-wall tile of the Great Hall doorway for the Hall at `index` (a corridor tile past six). */
function hallDoorTile(index: number, mainWidth: number): Rect {
  const x = index < TEMPLATE_DOORS ? 1 + 3 * index : mainWidth + 3 * (index - TEMPLATE_DOORS)
  return { x, y: 2, w: 1, h: 1 }
}

/**
 * The room for a Hall: the smallest template that holds a station per Member, the Captain at the
 * head desk. Members past the largest template stand on free floor tiles.
 */
export function roomFor(hall: RoomHall, members: readonly RoomMember[], style: RoomStyle): Room {
  const size = sizeFor(members.length)
  const t = readTemplate(`${style}-${size}`)
  const { objects, ...room } = assemble(`hall:${hall.id}`, style, size, t)
  const order = [...members.filter((m) => m.captain), ...members.filter((m) => !m.captain)]
  const seats = objects
    .filter((o) => o.type === 'station')
    .sort((a, b) => num(a, 'index') - num(b, 'index'))
  const used = new Set(seats.map((o) => `${o.x / t.tileSize},${o.y / t.tileSize}`))
  const door = objects.find((o) => o.type === 'doorway')
  const doorTile = door ? tileRect(door, t.tileSize) : { x: 0, y: t.height - 1, w: 1, h: 1 }
  const front = `${doorTile.x},${doorTile.y - 1}`
  const spare = Array.from({ length: t.width * t.height }, (_v, i) => ({
    x: i % t.width,
    y: Math.floor(i / t.width),
  }))
    .filter((p) => p.y >= 6 && room.walkable(p.x, p.y) && !used.has(`${p.x},${p.y}`))
    .filter((p) => `${p.x},${p.y}` !== front)
    .sort(
      (a, b) => Number((a.y - 6) % 3 !== 0) - Number((b.y - 6) % 3 !== 0) || a.y - b.y || a.x - b.x
    )
  const stations: Station[] = order.map((m, i) => {
    const seat = seats[i]
    if (seat && i < LARGEST_TEMPLATE) {
      const deskAt = { x: num(seat, 'deskX'), y: num(seat, 'deskY') }
      const desk = room.furniture.find((f) => f.tile.x === deskAt.x && f.tile.y === deskAt.y)
      return {
        memberId: m.id,
        tile: { x: seat.x / t.tileSize, y: seat.y / t.tileSize },
        facing: 'up',
        desk: desk?.tile ?? null,
        captain: i === 0 && m.captain === true,
      }
    }
    const tile = spare.shift() ?? { x: room.spawn.x, y: room.spawn.y }
    return { memberId: m.id, tile, facing: 'down', desk: null, captain: false }
  })
  const there = hallDoorTile(hall.index ?? 0, readTemplate('great-hall').width)
  return {
    ...room,
    stations,
    doorways: [
      {
        tile: doorTile,
        target: 'great-hall',
        entry: { x: there.x, y: there.y + 1 },
        locked: false,
        label: 'Great Hall',
      },
    ],
  }
}

/** The Great Hall with a doorway per Hall in config order, and a corridor past six. */
export function greatHall(halls: readonly RoomHall[]): Room {
  const t = readTemplate('great-hall')
  const mainWidth = t.width
  const extra = Math.max(0, halls.length - TEMPLATE_DOORS)
  const width = mainWidth + 3 * extra
  const wall = (part: string) => `wall-great-hall-${part}`
  const grow = <T>(rows: readonly T[], fill: T): T[] => {
    const out: T[] = []
    for (let y = 0; y < t.height; y++) {
      for (let x = 0; x < width; x++) {
        out.push(x < mainWidth ? (rows[y * mainWidth + x] ?? fill) : fill)
      }
    }
    return out
  }
  const layers: RoomLayers = {
    floor: grow(t.layers.floor, null),
    wallFace: grow(t.layers.wallFace, null),
    wallTop: grow(t.layers.wallTop, null),
    decor: grow(t.layers.decor, null),
  }
  const collision = grow(t.collision, true)
  const at = (x: number, y: number) => y * width + x
  const stone = 'floor-stone'
  if (extra > 0) {
    // Open the old right wall at the three floor rows beside the first corridor door, then build the strip.
    for (let y = 3; y <= 5; y++) {
      layers.wallTop[at(mainWidth - 1, y)] = null
      layers.floor[at(mainWidth - 1, y)] = stone
      collision[at(mainWidth - 1, y)] = false
    }
    for (let x = mainWidth; x < width; x++) {
      const edge = x === width - 1
      for (let y = 0; y <= 6; y++) {
        const i = at(x, y)
        if (edge || y === 6 || y === 0) {
          layers.wallTop[i] = wall('top')
          collision[i] = true
        } else if (y <= 2) {
          layers.wallFace[i] = wall(`face-${y}`)
          collision[i] = true
        } else {
          layers.floor[i] = stone
          collision[i] = false
        }
      }
    }
  }
  const doors = t.objects.filter((o) => o.type === 'doorway')
  const hallDoors: Doorway[] = halls.map((h, i) => {
    const tile = hallDoorTile(i, mainWidth)
    if (i >= TEMPLATE_DOORS) {
      layers.decor[at(tile.x, 1)] = 'doorway'
      layers.wallFace[at(tile.x, 2)] = null
      layers.floor[at(tile.x, 2)] = stone
      collision[at(tile.x, 2)] = false
    }
    return {
      tile,
      target: `hall:${h.id}`,
      entry: null,
      hallId: h.id,
      locked: h.locked,
      label: h.name,
    }
  })
  // A template doorway with no Hall behind it is a plain wall.
  for (let i = halls.length; i < TEMPLATE_DOORS; i++) {
    const tile = hallDoorTile(i, mainWidth)
    layers.decor[at(tile.x, 1)] = null
    layers.floor[at(tile.x, 2)] = null
    layers.wallFace[at(tile.x, 2)] = wall('face-2')
    collision[at(tile.x, 2)] = true
  }
  const exit = doors.find((o) => prop(o, 'target') === 'plaza')
  const exitTile = exit ? tileRect(exit, t.tileSize) : { x: 0, y: t.height - 1, w: 1, h: 1 }
  const base = assemble('great-hall', 'great-hall', 'great', t)
  const { objects: _objects, ...room } = base
  const walkable = (x: number, y: number) =>
    Number.isInteger(x) &&
    Number.isInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < width &&
    y < t.height &&
    collision[y * width + x] === false
  return {
    ...room,
    width,
    layers,
    collision,
    walkable,
    stations: [],
    doorways: [
      ...hallDoors,
      { tile: exitTile, target: 'plaza', entry: null, locked: false, label: 'Plaza' },
    ],
  }
}

const KEYWORDS: readonly (readonly [RoomStyle, readonly string[]])[] = [
  [
    'writing-room',
    ['herald', 'writ', 'scribe', 'messag', 'comm', 'mail', 'content', 'press', 'news', 'social'],
  ],
  ['library', ['research', 'librar', 'archiv', 'study', 'learn', 'knowledge', 'note', 'read']],
  ['studio', ['design', 'art', 'studio', 'creativ', 'media', 'music', 'video', 'paint']],
  ['infirmary', ['health', 'well', 'medic', 'clinic', 'care', 'fitness', 'doctor']],
  ['garden-room', ['garden', 'home', 'nature', 'outdoor', 'plant', 'farm', 'house']],
  ['workshop', ['forge', 'build', 'dev', 'engineer', 'ops', 'tool', 'craft', 'make', 'code']],
]

/** The room style a Hall gets without a choice: by kind, then name keywords, then workshop. */
export function defaultStyle(hall: { name: string; kind: 'work' | 'private' }): RoomStyle {
  if (hall.kind === 'private') {
    return 'quiet-room'
  }
  const name = hall.name.toLowerCase()
  return KEYWORDS.find(([, words]) => words.some((w) => name.includes(w)))?.[0] ?? 'workshop'
}

/** The style a Hall's room uses: the Guild Master's `roomStyle` choice, else {@link defaultStyle}. */
export function styleFor(hall: {
  name: string
  kind: 'work' | 'private'
  roomStyle?: RoomStyle | undefined
}): RoomStyle {
  return hall.roomStyle ?? defaultStyle(hall)
}
