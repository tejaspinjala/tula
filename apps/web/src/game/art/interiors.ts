import { blank, box, type Rows, recolour, rep, stamp } from './compose'
import { type Sprite, STYLES, type Style } from './types'

/** Wood planks, four to a tile, each with a lit top edge, a seam below and a staggered joint. */
const FLOOR_WOOD: Rows = [
  '4444444444244444',
  '3333333333233333',
  '3333333333233333',
  '2222222222222222',
  '4442444444444444',
  '3332333333333333',
  '3332333333333333',
  '2222222222222222',
  '4444444444442444',
  '3333333333332333',
  '3333333333332333',
  '2222222222222222',
  '4444442444444444',
  '3333332333333333',
  '3333332333333333',
  '2222222222222222',
]

/** Staggered stone blocks with a lit top edge and dark joints. */
const FLOOR_STONE: Rows = [
  'aaaaaaasaaaaaaaa',
  'tttttttstttttttt',
  'ttzttttsttttttzt',
  'tttttttstttttttt',
  'tttttttstttttttt',
  'tttttttstttttttt',
  'tttttttstttttttt',
  'ssssssssssssssss',
  'aaasaaaaaaasaaaa',
  'tttstttttttstttt',
  'tttsttttzttstttt',
  'tttstttttttstttt',
  'tttstttttttstttt',
  'tttstttttttsttzt',
  'tttstttttttstttt',
  'ssssssssssssssss',
]

const TILE_LIGHT: Rows = ['pppppppr', ...rep('pqqqqqqr', 6), 'rrrrrrrr']
const TILE_COOL: Rows = ['DDDDDDDr', ...rep('DCCCCCCr', 6), 'rrrrrrrr']

function checker(a: Rows, b: Rows): Rows {
  const row = (l: Rows, r: Rows) => l.map((line, y) => line + (r[y] ?? ''))
  return [...row(a, b), ...row(b, a)]
}

/** A one-colour variant of a floor: the next ramp step up. */
const LIGHTER = { '2': '3', '3': '4', '4': '5', s: 't', t: 'a', a: 'z' }

/** The 9 slices of a rug: ink outline, border, trim, then the field with a dotted pattern. */
function rugSet(name: string, border: string, trim: string, field: string): Sprite[] {
  const slice = (tag: string, dist: (x: number, y: number) => number, round: boolean): Sprite => ({
    name: `rug-${name}-${tag}`,
    group: 'shared',
    atlas: 'interiors',
    rows: Array.from({ length: 16 }, (_, y) =>
      Array.from({ length: 16 }, (_, x) => {
        const d = dist(x, y)
        if (round && d === 0 && (x === 0 || x === 15) && (y === 0 || y === 15)) {
          return '.'
        }
        if (d === 0) {
          return 'k'
        }
        if (d <= 2) {
          return border
        }
        if (d === 3) {
          return trim
        }
        return tag === 'c' && x % 8 === 3 && y % 8 === 3 ? border : field
      }).join('')
    ),
  })
  const far = 99
  return [
    slice('tl', (x, y) => Math.min(x, y), true),
    slice('t', (_, y) => y, false),
    slice('tr', (x, y) => Math.min(15 - x, y), true),
    slice('l', (x) => x, false),
    slice('c', () => far, false),
    slice('r', (x) => 15 - x, false),
    slice('bl', (x, y) => Math.min(x, 15 - y), true),
    slice('b', (_, y) => 15 - y, false),
    slice('br', (x, y) => Math.min(15 - x, 15 - y), true),
  ]
}

/** The cornice of a back wall: the wall's top seen from above, a dark void over it. */
const WALL_TOP: Rows = [
  ...rep('kkkkkkkkkkkkkkkk', 10),
  '5555555555555555',
  '4444444444444444',
  '4444444444444444',
  '4444444444444444',
  '3333333333333333',
  '2222222222222222',
]

const PLANK = '2433333324333333'
const WALL_FACE_1: Rows = ['2222222222222222', ...rep(PLANK, 15)]
const WALL_FACE_2: Rows = [
  ...rep(PLANK, 12),
  '4444444444444444',
  '2222222222222222',
  '2222222222222222',
  '1111111111111111',
]

/** How each style recolours the plank wall: the five wood steps and the outline. */
const WALLS: Record<Style, Record<string, string>> = {
  'great-hall': { '1': 's', '2': 's', '3': 't', '4': 'a', '5': 'z' },
  'writing-room': { '1': '2', '2': 'r', '3': 'q', '4': 'p', '5': 'w' },
  library: { '1': 'k', '2': '1', '3': '2', '4': '3', '5': '4' },
  workshop: {},
  studio: { '1': 'm', '2': 'm', '3': 'n', '4': 'v', '5': 'v' },
  infirmary: { '1': 'f', '2': 'f', '3': 'C', '4': 'D', '5': 'w' },
  'garden-room': { '1': 'g', '2': 'g', '3': 'A', '4': 'B', '5': 'i' },
  'quiet-room': { '1': '2', '2': '3', '3': '4', '4': '5', '5': 'p' },
}

function wallSprites(): Sprite[] {
  return STYLES.flatMap((style) => {
    const map = WALLS[style]
    return [
      { name: `wall-${style}-top`, rows: recolour(WALL_TOP, map) },
      { name: `wall-${style}-face-1`, rows: recolour(WALL_FACE_1, map) },
      { name: `wall-${style}-face-2`, rows: recolour(WALL_FACE_2, map) },
    ].map((s): Sprite => ({ ...s, group: style, atlas: 'interiors' }))
  })
}

function pane(glint: number): string {
  return glint === 1 ? 'ccwcc' : glint === 2 ? 'cwccc' : 'ccccc'
}

const WINDOW: Rows = [
  '.kkkkkkkkkkkkkk.',
  'k55555555555555k',
  ...[0, 0, 1, 2, 0, 0, 0, 0, 0].map((g) => `k5${pane(g)}22${pane(g)}5k`),
  `k5${'2'.repeat(12)}5k`,
  `k5${'2'.repeat(12)}5k`,
  ...[0, 0, 1, 2, 0, 0, 0, 0].map((g) => `k5${pane(g)}22${pane(g)}5k`),
  'k55555555555555k',
  'k44444444444444k',
  'kkkkkkkkkkkkkkkk',
]

/** A shelf of books: `cols` colours the 14 spines, `heights` how tall (1 to 6) each stands. */
export function books(cols: string, heights: readonly number[]): Rows {
  const rows = Array.from({ length: 6 }, (_, y) =>
    [...cols].map((c, i) => (6 - y <= (heights[i] ?? 6) ? c : '1')).join('')
  )
  return [...rows.map((r) => `k${r}k`), `k${'4'.repeat(14)}k`]
}

const SHELF_WALL: Rows = [
  'kkkkkkkkkkkkkkkk',
  ...books('dbyvgdeybhdvyb', [6, 5, 6, 6, 4, 6, 5, 6, 6, 5, 6, 4, 6, 5]),
  ...books('vgbdyhbdevyghd', [5, 6, 6, 4, 6, 6, 5, 6, 4, 6, 6, 5, 6, 6]),
  ...books('ybdgevhbydbgvy', [6, 6, 5, 6, 6, 4, 6, 6, 5, 6, 4, 6, 6, 5]),
  `k${'2'.repeat(14)}k`,
  'kkkkkkkkkkkkkkkk',
]

const PICTURE_A: Rows = stamp(stamp(blank(16, 16), 2, 3, box(12, 10, 'o', 'k')), 4, 5, [
  'ccccccyc',
  'cccccccc',
  'cchccccc',
  'hhhhhhhh',
  'gggghhgg',
  'gggggggg',
])

const PICTURE_B: Rows = stamp(stamp(blank(16, 16), 3, 2, box(10, 12, 'o', 'k')), 5, 4, [
  'EEEEEE',
  'EEkkEE',
  'EE55EE',
  'EE55EE',
  'EddddE',
  'EddddE',
  'EddddE',
  'EEEEEE',
])

const SCONCE: Rows = [
  ...blank(16, 3),
  '.......y........',
  '......yuy.......',
  '......yuy.......',
  '.....kkkkkk.....',
  '......k33k......',
  '.......kk.......',
  ...blank(16, 7),
]

const DOORWAY: Rows = stamp(stamp(box(16, 32, '2', 'k'), 2, 3, box(12, 29, '1', 'k')), 1, 1, [
  '55555555555555',
])

const DOOR_MAT: Rows = stamp(
  stamp(blank(16, 16), 1, 3, box(14, 10, 'd', 'k')),
  3,
  5,
  box(10, 6, 'e', 'y')
)

function shared(name: string, rows: Rows): Sprite {
  return { name, group: 'shared', atlas: 'interiors', rows }
}

/** Every wall, floor, rug and wall decoration of the interiors atlas. */
export function interiorSprites(): Sprite[] {
  return [
    shared('floor-wood', FLOOR_WOOD),
    shared('floor-wood-b', recolour(FLOOR_WOOD, LIGHTER)),
    shared('floor-stone', FLOOR_STONE),
    shared('floor-stone-b', recolour(FLOOR_STONE, LIGHTER)),
    shared('floor-tile', checker(TILE_LIGHT, TILE_COOL)),
    shared('floor-tile-b', checker(TILE_COOL, TILE_LIGHT)),
    ...rugSet('red', 'd', 'y', 'e'),
    ...rugSet('blue', 'b', 'c', 'E'),
    ...rugSet('green', 'g', 'i', 'h'),
    ...wallSprites(),
    shared('window', WINDOW),
    shared('shelf-wall', SHELF_WALL),
    shared('picture-a', PICTURE_A),
    shared('picture-b', PICTURE_B),
    shared('sconce', SCONCE),
    shared('doorway', DOORWAY),
    shared('door-mat', DOOR_MAT),
  ]
}
