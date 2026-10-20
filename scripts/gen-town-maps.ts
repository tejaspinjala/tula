/**
 * Writes the town's Tiled maps (plaza, archive, vault, trail) as Tiled 1.10 JSON next to the
 * hand-written hall map. The maps are drawn from the Kenney Roguelike/RPG sheet (CC0) that the
 * hall already uses; each is a few rectangles of tiles, so the layout is reviewable here and the
 * JSON is the output. Run `bun scripts/gen-town-maps.ts` after changing a map.
 */
import { join } from 'node:path'

/** A tile of the Kenney sheet, by row and column (57 columns). */
const at = (row: number, col: number) => row * 57 + col

const T = {
  grass: at(0, 5),
  dirt: at(0, 6),
  stone: at(0, 7),
  cobble: at(0, 9),
  wood: at(2, 8),
  wall: 120,
  tree: at(9, 15),
  pine: at(9, 18),
  door: at(0, 32),
  doorB: at(0, 33),
  boardL: at(0, 17),
  boardR: at(0, 18),
  sign: at(0, 19),
  lamp: at(7, 17),
  candles: at(8, 19),
  shelfA: at(0, 30),
  shelfB: at(0, 31),
  shelfC: at(1, 30),
  shelfD: at(1, 31),
  table: at(3, 27),
  chair: at(2, 19),
  chestA: at(9, 37),
  chestB: at(9, 38),
  gold: at(10, 43),
  goldBig: at(11, 44),
  banner: at(0, 49),
} as const

type Layer = 'floor' | 'walls' | 'furniture'
type Rect = readonly [number, number, number, number]

interface Op {
  rect: Rect
  layer: Layer
  tile: number
  /** The tile blocks walking (and goes on the collision layer). */
  solid?: boolean
}

interface Place {
  name: string
  rect: Rect
  stand: readonly [number, number]
}

interface Door {
  rect: Rect
  to: string
  toX: number
  toY: number
}

interface MapSpec {
  file: string
  width: number
  height: number
  floor: number
  ops: Op[]
  /** Tiles laid after the clears (door leaves in a cleared doorway). */
  after?: Op[]
  /** Rectangles cleared of walls, furniture and collision after the ops (doorways, gaps). */
  clears: Rect[]
  places: Place[]
  doors: Door[]
  lanterns: (readonly [number, number])[]
}

const fill = (rect: Rect, layer: Layer, tile: number, solid = false): Op => ({
  rect,
  layer,
  tile,
  solid,
})
const row = (x: number, y: number, tiles: readonly number[], layer: Layer, solid = true): Op[] =>
  tiles.map((tile, i) => fill([x + i, y, 1, 1], layer, tile, solid))
const lamps = (spots: readonly (readonly [number, number])[]): Op[] =>
  spots.map(([x, y]) => fill([x, y, 1, 1], 'furniture', T.lamp, true))

const plazaLamps = [
  [11, 9],
  [24, 9],
  [11, 14],
  [24, 14],
  [3, 8],
  [32, 8],
] as const

const plaza: MapSpec = {
  file: 'plaza.tiled.json',
  width: 36,
  height: 20,
  floor: T.grass,
  ops: [
    fill([0, 0, 36, 1], 'furniture', T.pine, true),
    fill([0, 19, 36, 1], 'furniture', T.pine, true),
    fill([0, 1, 1, 18], 'furniture', T.tree, true),
    fill([35, 1, 1, 18], 'furniture', T.tree, true),
    // The roads and the cobbled square.
    fill([5, 7, 2, 5], 'floor', T.dirt),
    fill([5, 11, 26, 2], 'floor', T.dirt),
    fill([17, 7, 2, 3], 'floor', T.dirt),
    fill([29, 7, 2, 5], 'floor', T.dirt),
    fill([12, 9, 12, 6], 'floor', T.cobble),
    fill([24, 13, 12, 2], 'floor', T.dirt),
    // The Guild Hall, the Archive and the Treasury vault: stone fronts with a door each.
    fill([1, 2, 10, 5], 'walls', T.wall, true),
    fill([13, 2, 10, 5], 'walls', T.wall, true),
    fill([25, 2, 10, 5], 'walls', T.wall, true),
    fill([2, 2, 8, 1], 'furniture', T.banner),
    fill([14, 2, 8, 1], 'furniture', T.banner),
    fill([26, 2, 8, 1], 'furniture', T.banner),
    fill([8, 7, 1, 1], 'furniture', T.sign, true),
    fill([20, 7, 1, 1], 'furniture', T.sign, true),
    fill([32, 7, 1, 1], 'furniture', T.sign, true),
    // The Quest Board in the square.
    fill([17, 10, 1, 1], 'furniture', T.boardL, true),
    fill([18, 10, 1, 1], 'furniture', T.boardR, true),
    ...lamps(plazaLamps),
    // A few trees to keep the meadow from looking mown.
    ...[
      [3, 14],
      [4, 17],
      [8, 15],
      [9, 17],
      [28, 16],
      [31, 17],
      [14, 17],
      [22, 17],
      [3, 10],
    ].map(([x, y]) => fill([x ?? 0, y ?? 0, 1, 1], 'furniture', T.tree, true)),
  ],
  after: [
    fill([5, 6, 1, 1], 'furniture', T.door),
    fill([6, 6, 1, 1], 'furniture', T.doorB),
    fill([17, 6, 1, 1], 'furniture', T.door),
    fill([18, 6, 1, 1], 'furniture', T.doorB),
    fill([29, 6, 1, 1], 'furniture', T.door),
    fill([30, 6, 1, 1], 'furniture', T.doorB),
  ],
  clears: [
    [5, 6, 2, 1],
    [17, 6, 2, 1],
    [29, 6, 2, 1],
    [35, 13, 1, 2],
  ],
  places: [
    { name: 'quest-board', rect: [17, 10, 2, 1], stand: [17, 11] },
    { name: 'trail', rect: [33, 13, 3, 2], stand: [33, 13] },
  ],
  doors: [
    { rect: [5, 6, 2, 1], to: 'hall', toX: 38, toY: 12 },
    { rect: [17, 6, 2, 1], to: 'archive', toX: 7, toY: 10 },
    { rect: [29, 6, 2, 1], to: 'vault', toX: 6, toY: 8 },
    { rect: [35, 13, 1, 2], to: 'trail', toX: 1, toY: 4 },
  ],
  lanterns: [...plazaLamps, [5, 7], [17, 7], [29, 7]],
}

const archiveLamps = [
  [1, 9],
  [14, 9],
] as const

const archive: MapSpec = {
  file: 'archive.tiled.json',
  width: 16,
  height: 12,
  floor: T.wood,
  ops: [
    fill([0, 0, 16, 1], 'walls', T.wall, true),
    fill([0, 11, 16, 1], 'walls', T.wall, true),
    fill([0, 1, 1, 10], 'walls', T.wall, true),
    fill([15, 1, 1, 10], 'walls', T.wall, true),
    // Two courses of shelves along the back wall.
    ...Array.from({ length: 14 }, (_, i) =>
      fill([1 + i, 1, 1, 1], 'furniture', i % 2 === 0 ? T.shelfA : T.shelfB, true)
    ),
    ...Array.from({ length: 14 }, (_, i) =>
      fill([1 + i, 2, 1, 1], 'furniture', i % 2 === 0 ? T.shelfC : T.shelfD, true)
    ),
    ...row(3, 6, [T.table, T.table, T.table], 'furniture'),
    ...row(10, 6, [T.table, T.table, T.table], 'furniture'),
    ...row(3, 7, [T.chair, T.chair], 'furniture', false),
    ...row(11, 7, [T.chair, T.chair], 'furniture', false),
    ...archiveLamps.map(([x, y]) => fill([x, y, 1, 1], 'furniture', T.candles, true)),
  ],
  clears: [[7, 11, 2, 1]],
  places: [{ name: 'archive-shelves', rect: [1, 1, 14, 2], stand: [7, 3] }],
  doors: [{ rect: [7, 11, 2, 1], to: 'plaza', toX: 17, toY: 7 }],
  lanterns: [...archiveLamps, [4, 4], [11, 4]],
}

const vault: MapSpec = {
  file: 'vault.tiled.json',
  width: 14,
  height: 10,
  floor: T.stone,
  ops: [
    fill([0, 0, 14, 1], 'walls', T.wall, true),
    fill([0, 9, 14, 1], 'walls', T.wall, true),
    fill([0, 1, 1, 8], 'walls', T.wall, true),
    fill([13, 1, 1, 8], 'walls', T.wall, true),
    ...row(
      3,
      1,
      [T.chestA, T.gold, T.chestB, T.goldBig, T.chestA, T.gold, T.chestB, T.goldBig],
      'furniture'
    ),
    ...row(
      3,
      2,
      [T.goldBig, T.chestB, T.gold, T.chestA, T.goldBig, T.chestB, T.gold, T.chestA],
      'furniture'
    ),
    fill([1, 3, 1, 1], 'furniture', T.candles, true),
    fill([12, 3, 1, 1], 'furniture', T.candles, true),
  ],
  clears: [[6, 9, 2, 1]],
  places: [{ name: 'treasury-vault', rect: [3, 1, 8, 2], stand: [6, 4] }],
  doors: [{ rect: [6, 9, 2, 1], to: 'plaza', toX: 29, toY: 7 }],
  lanterns: [
    [1, 3],
    [12, 3],
    [6, 6],
  ],
}

const trailLamps = [
  [3, 3],
  [14, 6],
] as const

const trail: MapSpec = {
  file: 'trail.tiled.json',
  width: 28,
  height: 10,
  floor: T.grass,
  ops: [
    fill([0, 4, 28, 2], 'floor', T.dirt),
    fill([0, 0, 28, 1], 'furniture', T.pine, true),
    fill([0, 9, 28, 1], 'furniture', T.pine, true),
    ...[
      [2, 1],
      [6, 2],
      [10, 1],
      [17, 2],
      [21, 1],
      [4, 8],
      [9, 7],
      [13, 8],
      [19, 7],
      [24, 8],
    ].map(([x, y]) => fill([x ?? 0, y ?? 0, 1, 1], 'furniture', T.tree, true)),
    ...lamps(trailLamps),
    fill([25, 3, 1, 1], 'furniture', T.sign, true),
  ],
  clears: [],
  places: [{ name: 'wilds', rect: [26, 3, 2, 4], stand: [26, 4] }],
  doors: [{ rect: [0, 4, 1, 2], to: 'plaza', toX: 34, toY: 13 }],
  lanterns: trailLamps.map(([x, y]) => [x, y] as const),
}

/** The Tiled JSON for one map spec. */
function tiled(spec: MapSpec) {
  const size = spec.width * spec.height
  const grid = (): number[] => new Array<number>(size).fill(0)
  const layers: Record<Layer | 'collision', number[]> = {
    floor: new Array<number>(size).fill(spec.floor + 1),
    walls: grid(),
    furniture: grid(),
    collision: grid(),
  }
  const apply = (ops: readonly Op[]) => {
    for (const op of ops) {
      const [x, y, w, h] = op.rect
      for (let ty = y; ty < y + h; ty++) {
        for (let tx = x; tx < x + w; tx++) {
          const i = ty * spec.width + tx
          layers[op.layer][i] = op.tile + 1
          if (op.solid) {
            layers.collision[i] = 120
          }
        }
      }
    }
  }
  apply(spec.ops)
  for (const [x, y, w, h] of spec.clears) {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        const i = ty * spec.width + tx
        layers.walls[i] = 0
        layers.collision[i] = 0
        layers.furniture[i] = 0
      }
    }
  }
  apply(spec.after ?? [])
  let id = 1
  const px = (n: number) => n * 16
  const box = (rect: Rect) => ({
    x: px(rect[0]),
    y: px(rect[1]),
    width: px(rect[2]),
    height: px(rect[3]),
    rotation: 0,
    visible: true,
  })
  const objects = [
    ...spec.places.map((p) => ({
      id: id++,
      name: p.name,
      type: 'place',
      ...box(p.rect),
      properties: [
        { name: 'standX', type: 'int', value: p.stand[0] },
        { name: 'standY', type: 'int', value: p.stand[1] },
      ],
    })),
    ...spec.doors.map((d) => ({
      id: id++,
      name: `door-to-${d.to}`,
      type: 'door',
      ...box(d.rect),
      properties: [
        { name: 'to', type: 'string', value: d.to },
        { name: 'toX', type: 'int', value: d.toX },
        { name: 'toY', type: 'int', value: d.toY },
      ],
    })),
    ...spec.lanterns.map(([x, y]) => ({
      id: id++,
      name: 'lantern',
      type: 'lantern',
      ...box([x, y, 1, 1]),
    })),
  ]
  const tileLayer = (name: string, data: number[], n: number) => ({
    id: n,
    name,
    type: 'tilelayer',
    width: spec.width,
    height: spec.height,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    data,
  })
  return {
    compressionlevel: -1,
    width: spec.width,
    height: spec.height,
    tilewidth: 16,
    tileheight: 16,
    infinite: false,
    orientation: 'orthogonal',
    renderorder: 'right-down',
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    nextlayerid: 6,
    nextobjectid: id,
    tilesets: [
      {
        firstgid: 1,
        name: 'roguelike',
        image: 'tiles.png',
        imagewidth: 968,
        imageheight: 526,
        tilewidth: 16,
        tileheight: 16,
        margin: 0,
        spacing: 1,
        columns: 57,
        tilecount: 1767,
      },
    ],
    layers: [
      tileLayer('floor', layers.floor, 1),
      tileLayer('walls', layers.walls, 2),
      tileLayer('furniture', layers.furniture, 3),
      tileLayer('collision', layers.collision, 4),
      {
        id: 5,
        name: 'objects',
        type: 'objectgroup',
        draworder: 'topdown',
        x: 0,
        y: 0,
        opacity: 1,
        visible: true,
        objects,
      },
    ],
  }
}

const dir = join(import.meta.dir, '..', 'apps', 'web', 'src', 'game')
for (const spec of [plaza, archive, vault, trail]) {
  await Bun.write(join(dir, spec.file), `${JSON.stringify(tiled(spec))}\n`)
}
