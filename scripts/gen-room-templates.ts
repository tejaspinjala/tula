/**
 * Writes the room templates of the three-quarter Guildhall (ADR-0016) as Tiled 1.10 JSON: one map per
 * room style and size (S up to 4 stations, M up to 8, L up to 12) plus the Great Hall. The layout is
 * reviewable here and the JSON is the output; the room model reads it. Run
 * `bun scripts/gen-room-templates.ts` after changing a template.
 *
 * Every tile layer is a `width * height` array of gids into the `interiors` tileset, where each tile's
 * `type` is its frame name in `apps/web/public/game/interiors.json`. Furniture and anchors are Tiled
 * objects in pixels; their `type` says what they are.
 */
import furnitureAtlas from '../apps/web/public/game/furniture.json'
import interiorsAtlas from '../apps/web/public/game/interiors.json'

/** Where the committed templates live. */
export const ROOM_TEMPLATES_PATH = new URL(
  '../apps/web/src/game/roomtemplates.tiled.json',
  import.meta.url
).pathname

/** The Hall room styles (the Great Hall is a template of its own). */
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
export type RoomStyleName = (typeof ROOM_STYLES)[number]

/** The template sizes: columns of desks, rows of desks, and how many stations the room holds. */
export const SIZES = {
  S: { cols: 3, rows: 1, capacity: 4 },
  M: { cols: 4, rows: 2, capacity: 8 },
  L: { cols: 6, rows: 2, capacity: 12 },
} as const
type SizeName = keyof typeof SIZES

const TILE = 16
const interiorFrames = Object.keys(interiorsAtlas.frames).sort()
const furnitureFrames: Record<string, { w: number; h: number }> = furnitureAtlas.frames

interface Style {
  floor: string
  rug: 'red' | 'green' | 'blue' | null
  desk: string
  /** Back-wall decor cycle on the face rows, starting at x = 2 and stepping by 3. */
  decor: readonly string[]
  /** Pieces against the back wall (row 3) from the left, from the right, and in the middle. */
  backLeft: readonly string[]
  backRight: readonly string[]
  center: string | null
  /** The two corner pieces of the entry row. */
  corners: readonly [string, string]
}

const STYLE: Record<RoomStyleName, Style> = {
  'writing-room': {
    floor: 'floor-wood',
    rug: 'red',
    desk: 'writing-desk',
    decor: ['window', 'picture-a'],
    backLeft: ['bookshelf'],
    backRight: ['bookshelf'],
    center: null,
    corners: ['plant-large', 'lamp-floor'],
  },
  library: {
    floor: 'floor-wood',
    rug: 'green',
    desk: 'reading-table',
    decor: ['shelf-wall', 'window', 'sconce'],
    backLeft: ['bookshelf', 'bookshelf', 'bookshelf'],
    backRight: ['globe', 'bookshelf', 'bookshelf'],
    center: null,
    corners: ['plant-small', 'lamp-floor'],
  },
  workshop: {
    floor: 'floor-stone',
    rug: null,
    desk: 'workbench',
    decor: ['window', 'shelf-wall', 'window', 'picture-b'],
    backLeft: ['tool-rack', 'tool-rack'],
    backRight: ['anvil', 'tool-rack'],
    center: null,
    corners: ['lamp-floor', 'plant-small'],
  },
  studio: {
    floor: 'floor-wood',
    rug: 'blue',
    desk: 'paint-table',
    decor: ['window', 'picture-a', 'window', 'picture-b'],
    backLeft: ['easel', 'easel'],
    backRight: ['plant-large'],
    center: null,
    corners: ['lamp-floor', 'plant-small'],
  },
  infirmary: {
    floor: 'floor-tile',
    rug: null,
    desk: 'medicine-table',
    decor: ['window', 'window', 'picture-a'],
    backLeft: ['medicine-cabinet', 'medicine-cabinet'],
    backRight: ['bed'],
    center: null,
    corners: ['plant-small', 'lamp-floor'],
  },
  'garden-room': {
    floor: 'floor-stone',
    rug: 'green',
    desk: 'low-table',
    decor: ['window'],
    backLeft: ['planter'],
    backRight: ['planter'],
    center: 'fountain',
    corners: ['plant-large', 'plant-large'],
  },
  'quiet-room': {
    floor: 'floor-wood',
    rug: 'blue',
    desk: 'low-table',
    decor: ['picture-a', 'window', 'sconce', 'picture-b'],
    backLeft: ['screen'],
    backRight: ['screen'],
    center: null,
    corners: ['armchair', 'lamp-floor'],
  },
}

type Cell = string | null
type Props = Record<string, number | string | boolean>
interface Obj {
  id: number
  name: string
  type: string
  x: number
  y: number
  width: number
  height: number
  rotation: 0
  visible: true
  properties: { name: string; type: 'int' | 'string' | 'bool'; value: number | string | boolean }[]
}

/** A room under construction: tile layers by frame name, a collision grid and the objects. */
class Plan {
  readonly floor: Cell[]
  readonly wallFace: Cell[]
  readonly wallTop: Cell[]
  readonly decor: Cell[]
  readonly blocked: number[]
  readonly furniture: Obj[] = []
  readonly anchors: Obj[] = []
  private nextId = 1

  constructor(
    readonly w: number,
    readonly h: number
  ) {
    this.floor = Array.from({ length: w * h }, (): Cell => null)
    this.wallFace = Array.from({ length: w * h }, (): Cell => null)
    this.wallTop = Array.from({ length: w * h }, (): Cell => null)
    this.decor = Array.from({ length: w * h }, (): Cell => null)
    this.blocked = Array.from({ length: w * h }, () => 0)
  }

  at(x: number, y: number): number {
    return y * this.w + x
  }

  block(x: number, y: number, w = 1, h = 1): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        this.blocked[this.at(x + i, y + j)] = 1
      }
    }
  }

  /** Floor everywhere inside, walls on the edges and a three-row back wall in `wall`'s style. */
  shell(floor: string, wall: string): void {
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const i = this.at(x, y)
        const edge = x === 0 || x === this.w - 1 || y === this.h - 1
        if (edge) {
          this.wallTop[i] = `wall-${wall}-top`
          this.block(x, y)
        } else if (y <= 2) {
          if (y === 0) {
            this.wallTop[i] = `wall-${wall}-top`
          } else {
            this.wallFace[i] = `wall-${wall}-face-${y}`
          }
          this.block(x, y)
        } else {
          this.floor[i] = floor
        }
      }
    }
  }

  /** Makes a wall tile walkable floor (a doorway). */
  open(x: number, y: number, floor: string): void {
    const i = this.at(x, y)
    this.blocked[i] = 0
    this.wallTop[i] = null
    this.wallFace[i] = null
    this.floor[i] = floor
  }

  object(
    name: string,
    type: string,
    x: number,
    y: number,
    w: number,
    h: number,
    props: Props = {}
  ) {
    const obj: Obj = {
      id: this.nextId++,
      name,
      type,
      x: x * TILE,
      y: y * TILE,
      width: w * TILE,
      height: h * TILE,
      rotation: 0,
      visible: true,
      properties: Object.entries(props).map(([k, value]) => ({
        name: k,
        type: typeof value === 'number' ? 'int' : typeof value === 'boolean' ? 'bool' : 'string',
        value,
      })),
    }
    if (type === 'furniture') {
      this.furniture.push(obj)
    } else {
      this.anchors.push(obj)
    }
  }

  /** A furniture piece on its footprint; it blocks walking. */
  piece(frame: string, x: number, y: number): { w: number; h: number } {
    const f = furnitureFrames[frame]
    if (!f) {
      throw new Error(`no furniture frame ${frame}`)
    }
    const w = f.w / TILE
    const h = f.h / TILE
    this.object(frame, 'furniture', x, y, w, h, { top: `${frame}~top` in furnitureFrames })
    this.block(x, y, w, h)
    return { w, h }
  }

  /** A rug of `w` by `h` tiles whose top-left tile is (x, y). */
  rug(colour: string, x: number, y: number, w: number, h: number): void {
    for (let j = 0; j < h; j++) {
      for (let i = 0; i < w; i++) {
        const v = j === 0 ? 't' : j === h - 1 ? 'b' : ''
        const u = i === 0 ? 'l' : i === w - 1 ? 'r' : ''
        this.floor[this.at(x + i, y + j)] = `rug-${colour}-${v + u || 'c'}`
      }
    }
  }

  /** A one-tile doorway in the back wall at (x, 2): stepping on it leaves the room. */
  wallDoor(x: number, floor: string, props: Props): void {
    this.decor[this.at(x, 1)] = 'doorway'
    this.open(x, 2, floor)
    this.object('doorway', 'doorway', x, 2, 1, 1, props)
  }

  /** A one-tile doorway in the front wall at (x, h - 1) with a mat inside and a spawn in front. */
  frontDoor(x: number, floor: string, props: Props): void {
    this.open(x, this.h - 1, floor)
    this.decor[this.at(x, this.h - 2)] = 'door-mat'
    this.object('door', 'doorway', x, this.h - 1, 1, 1, props)
    this.object('spawn', 'spawn', x, this.h - 2, 1, 1)
  }
}

/** Back-wall decor on the face rows, one every three tiles between the desk columns. */
function dress(plan: Plan, cycle: readonly string[], skip: ReadonlySet<number>): void {
  let n = 0
  for (let x = 2; x < plan.w - 2; x += 3) {
    const frame = cycle[n++ % cycle.length]
    if (frame && !skip.has(x)) {
      plan.decor[plan.at(x, 1)] = frame
    }
  }
}

function toTiled(plan: Plan) {
  const ids = new Map(interiorFrames.map((name, i) => [name, i + 1]))
  const gids = (cells: readonly Cell[]) => cells.map((c) => (c === null ? 0 : (ids.get(c) ?? 0)))
  const tile = (name: string, data: number[]) => ({
    type: 'tilelayer',
    name,
    width: plan.w,
    height: plan.h,
    data,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
  })
  const group = (name: string, objects: Obj[]) => ({
    type: 'objectgroup',
    name,
    objects,
    x: 0,
    y: 0,
    opacity: 1,
    visible: true,
    draworder: 'topdown',
  })
  return {
    type: 'map',
    version: '1.10',
    tiledversion: '1.10.2',
    orientation: 'orthogonal',
    renderorder: 'right-down',
    infinite: false,
    width: plan.w,
    height: plan.h,
    tilewidth: TILE,
    tileheight: TILE,
    nextlayerid: 8,
    nextobjectid: plan.furniture.length + plan.anchors.length + 1,
    tilesets: [
      {
        firstgid: 1,
        name: 'interiors',
        tilewidth: TILE,
        tileheight: TILE,
        tilecount: interiorFrames.length,
        columns: 0,
        tiles: interiorFrames.map((name, id) => ({ id, type: name })),
      },
    ],
    layers: [
      tile('floor', gids(plan.floor)),
      tile('wall-face', gids(plan.wallFace)),
      tile('wall-top', gids(plan.wallTop)),
      tile('decor', gids(plan.decor)),
      tile('collision', plan.blocked),
      group('furniture', plan.furniture),
      group('anchors', plan.anchors),
    ],
  }
}

/** The template of a Hall room: a head desk, rows of desks, a door at the front. */
function hallRoom(style: RoomStyleName, size: SizeName): Plan {
  const s = STYLE[style]
  const { cols, rows, capacity } = SIZES[size]
  const w = 3 * cols + 1
  const h = 7 + 3 * rows + 1
  const plan = new Plan(w, h)
  plan.shell(s.floor, style)
  const cx = Math.floor(w / 2) - 1
  const head = Math.floor((w - 2) / 2)
  plan.frontDoor(cx, s.floor, { target: 'great-hall' })
  if (s.rug) {
    plan.rug(s.rug, head - 1, 5, 4, 2)
  }
  const stations = [{ x: head, y: 4 }]
  for (let slot = 0; slot < capacity - 1; slot++) {
    stations.push({ x: 1 + 3 * (slot % cols), y: 7 + 3 * Math.floor(slot / cols) })
  }
  stations.forEach((st, i) => {
    plan.piece(s.desk, st.x, st.y)
    plan.object(i === 0 ? 'head-desk' : `station-${i}`, 'station', st.x, st.y + 1, 1, 1, {
      index: i,
      captain: i === 0,
      facing: 'up',
      deskX: st.x,
      deskY: st.y,
    })
  })
  let x = 1
  for (const frame of s.backLeft) {
    x += plan.piece(frame, x, 3).w
  }
  x = w - 1
  for (const frame of s.backRight) {
    x -= (furnitureFrames[frame]?.w ?? TILE) / TILE
    plan.piece(frame, x, 3)
  }
  if (s.center) {
    plan.piece(s.center, head, 3)
  }
  plan.piece(s.corners[0], 1, h - 2)
  plan.piece(s.corners[1], w - 2, h - 2)
  dress(plan, s.decor, new Set())
  return plan
}

/** Doorways the Great Hall template has before a corridor is added. */
export const GREAT_HALL_DOORS = 6

/** The Great Hall: Steward's desk, Seal desk, Quest Board, Mailbox, Gate, a door per Hall on the back wall. */
function greatHall(): Plan {
  const w = 3 * GREAT_HALL_DOORS + 1
  const h = 12
  const plan = new Plan(w, h)
  const floor = 'floor-stone'
  plan.shell(floor, 'great-hall')
  const doors = new Set<number>()
  for (let i = 0; i < GREAT_HALL_DOORS; i++) {
    plan.wallDoor(1 + 3 * i, floor, { slot: i })
    doors.add(1 + 3 * i)
  }
  const cx = Math.floor(w / 2) - 1
  plan.frontDoor(cx, floor, { target: 'plaza' })
  plan.rug('red', cx - 1, 6, 4, 2)
  const poi = (frame: string, x: number, y: number) => {
    const { w: pw, h: ph } = plan.piece(frame, x, y)
    plan.object(frame, 'poi', x, y, pw, ph, { standX: x, standY: y + 1 })
  }
  poi('steward-desk', cx, 5)
  poi('seal-desk', 3, 7)
  poi('quest-board', 13, 5)
  poi('mailbox', 16, 7)
  poi('gate', 11, 10)
  plan.piece('lamp-floor', 1, h - 2)
  plan.piece('plant-large', w - 2, h - 2)
  // Windows and sconces on the back wall between the doors.
  dress(plan, ['window', 'sconce'], doors)
  return plan
}

/** Every template by name: `<style>-<S|M|L>` and `great-hall`. */
export function buildRoomTemplates(): Record<string, unknown> {
  const out: Record<string, unknown> = { 'great-hall': toTiled(greatHall()) }
  for (const style of ROOM_STYLES) {
    for (const size of ['S', 'M', 'L'] as const) {
      out[`${style}-${size}`] = toTiled(hallRoom(style, size))
    }
  }
  return out
}

/** The committed file's text: deterministic for the art and the plans above. */
export function renderRoomTemplates(): string {
  return `${JSON.stringify({ templates: buildRoomTemplates() })}\n`
}

if (import.meta.main) {
  await Bun.write(ROOM_TEMPLATES_PATH, renderRoomTemplates())
}
