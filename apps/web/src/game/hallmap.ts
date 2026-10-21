import { z } from 'zod'

/** Room slots the drawn map has before it grows. */
export const BASE_SLOTS = 6
/** Rooms in one added wing (a corridor with a row of three rooms under it). */
const WING_ROOMS = 3
/** Rows one wing adds: a corridor of three, the doorway wall, eight room rows and a bottom wall. */
const WING_ROWS = 13
/** The left edge column of every room row (x) and each room's width in tiles, for the three columns. */
const ROOM_X = [3, 14, 27] as const
const ROOM_W = [10, 12, 12] as const
/** The column of the doorway in each room, two tiles wide. */
const DOOR_X = [6, 19, 32] as const
/** The shaft column that joins every corridor to the next one, down the left of the left rooms. */
const SHAFT = 1

const tileObject = z.looseObject({
  id: z.number(),
  name: z.string(),
  type: z.string(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
  properties: z
    .array(z.looseObject({ name: z.string(), type: z.string(), value: z.unknown() }))
    .optional(),
})
type TileObject = z.infer<typeof tileObject>
const tileLayer = z.looseObject({
  type: z.literal('tilelayer'),
  name: z.string(),
  data: z.array(z.number()),
})
const objectLayer = z.looseObject({ type: z.literal('objectgroup'), objects: z.array(tileObject) })
const rawMap = z.looseObject({
  width: z.number(),
  height: z.number(),
  tilewidth: z.number(),
  nextobjectid: z.number(),
  layers: z.array(z.union([tileLayer, objectLayer])),
})

/** How many wings a map needs so it has a room for each of `roomCount` Halls. */
export function wingsFor(roomCount: number): number {
  return roomCount <= BASE_SLOTS ? 0 : Math.ceil((roomCount - BASE_SLOTS) / WING_ROOMS)
}

/**
 * The Tiled hall map grown for `roomCount` Halls: every three Halls past the six drawn rooms add a
 * wing under the bottom row, reached by a shaft beside the first bottom room, so the map only
 * grows downward and the gate, desks and doorways above stay where they are. Six or fewer return
 * the map as drawn.
 */
export function hallMapFor(base: unknown, roomCount: number): unknown {
  const wings = wingsFor(roomCount)
  if (wings === 0) {
    return base
  }
  const map = rawMap.parse(base)
  const w = map.width
  const height = map.height + wings * WING_ROWS
  const rowsOf = (data: readonly number[], from: number, to: number): number[][] =>
    Array.from({ length: to - from }, (_row, i) => data.slice((from + i) * w, (from + i + 1) * w))
  const layers = map.layers.map((layer) => {
    if (layer.type === 'objectgroup') {
      return {
        ...layer,
        objects: wingObjects(layer.objects, wings, map.tilewidth, map.nextobjectid),
      }
    }
    const rows = rowsOf(layer.data, 0, map.height)
    const set = (r: number, x: number, v: number) => {
      const row = rows[r]
      if (row) {
        row[x] = v
      }
    }
    const blank = (fill: number) => Array.from({ length: w }, () => fill)
    const kind = layer.name
    const wall = kind === 'walls' || kind === 'collision'
    // Narrow the first bottom room to x 3..12: move its desk in, then wall its new left edge.
    if (kind === 'furniture' || kind === 'collision') {
      const desk = kind === 'furniture' ? 362 : 120
      set(17, 2, 0)
      set(17, 3, 0)
      set(17, 4, desk)
      set(17, 5, desk)
    }
    if (wall) {
      for (let r = 16; r < 24; r++) {
        set(r, 2, 120)
      }
    }
    // The shaft: open beside the first bottom room through the doorway wall, its rows and the bottom wall.
    for (let r = 15; r <= 24; r++) {
      set(r, SHAFT, kind === 'floor' ? 121 : 0)
    }
    const out = [...rows]
    for (let wing = 0; wing < wings; wing++) {
      // A corridor of three rows; walls only at the two edges.
      for (let i = 0; i < 3; i++) {
        out.push(
          kind === 'floor'
            ? blank(121)
            : blank(0).map((_v, x) => (wall && (x === 0 || x === w - 1) ? 120 : 0))
        )
      }
      // The doorway wall, the eight room rows and the bottom wall copy the drawn bottom rooms.
      for (let source = 15; source <= 24; source++) {
        out.push([...(rows[source] ?? blank(0))])
      }
    }
    // The last wing's shaft ends in a wall.
    const last = out[out.length - 1]
    if (last && wall) {
      last[SHAFT] = 120
    }
    return { ...layer, width: w, height, data: out.flat() }
  })
  return { ...map, height, layers }
}

/** The room and doorway objects the added wings carry, in slot order after the drawn six. */
function wingObjects(
  objects: readonly TileObject[],
  wings: number,
  size: number,
  firstId: number
): TileObject[] {
  const out: TileObject[] = objects.map((o) =>
    o.name === 'room4' ? { ...o, x: ROOM_X[0] * size, width: ROOM_W[0] * size } : o
  )
  let id = firstId
  const slotProps = (slot: number) => [{ name: 'slot', type: 'int', value: slot }]
  for (let wing = 0; wing < wings; wing++) {
    // The first wing's corridor starts under the drawn map (25 rows); each later one 13 rows below.
    const top = 25 + wing * WING_ROWS
    ROOM_X.forEach((x, column) => {
      const slot = BASE_SLOTS + wing * WING_ROOMS + column
      out.push({
        id: id++,
        name: `room${slot + 1}`,
        type: 'room',
        x: x * size,
        y: (top + 4) * size,
        width: (ROOM_W[column] ?? 12) * size,
        height: 8 * size,
        properties: slotProps(slot),
      })
      out.push({
        id: id++,
        name: `door${slot + 1}`,
        type: 'doorway',
        x: (DOOR_X[column] ?? 6) * size,
        y: (top + 3) * size,
        width: 2 * size,
        height: size,
        properties: slotProps(slot),
      })
    })
  }
  return out
}
