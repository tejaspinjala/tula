import { block, box, ellipse, paint, type Ramp, type Rows, recolour, rep, stamp } from './compose'
import { books } from './interiors'
import { furniture, type Sprite } from './types'

const WOOD: Ramp = { top: '4', light: '5', front: '3', shade: '2' }
const DARK: Ramp = { top: '3', light: '4', front: '2', shade: '1' }
const PALE: Ramp = { top: 'p', light: 'w', front: '4', shade: '3' }
const STONE: Ramp = { top: 'a', light: 'z', front: 't', shade: 's' }
const RED: Ramp = { top: 'e', light: 'e', front: 'd', shade: 'm' }
const BLUE: Ramp = { top: 'c', light: 'c', front: 'E', shade: 'b' }
const LINEN: Ramp = { top: 'D', light: 'w', front: 'C', shade: 'f' }
const PURPLE: Ramp = { top: 'v', light: 'v', front: 'n', shade: 'm' }
const SOIL: Ramp = { top: '2', light: '3', front: '3', shade: '2' }
const POT: Ramp = { top: '2', light: '3', front: 'e', shade: 'd' }

// Small things that sit on a desk or a shelf, drawn once and stamped.
const PAPERS: Rows = ['.kkkkkk.', 'kpppprrk', 'kprpppqk', 'kkkkkkkk']
const INKWELL: Rows = ['.k.', 'kbk', 'kbk', 'kkk']
const QUILL: Rows = ['...w', '..wk', '.wk.', 'kk..']
const BOOK_OPEN: Rows = ['kkkkkkkkkk', 'kpprkkrppk', 'kprpkkprpk', 'kpprkkrppk', 'kkkkkkkkkk']
const SEAL: Rows = ['.kkk.', 'kdddk', 'kdydk', 'kdddk', '.kkk.']
const HAMMER: Rows = ['.kkkk.', 'kttttk', '.kkkk.', '..k3k.', '..k3k.']
const WRENCH: Rows = ['.tt.', 't..t', 't..t', '.tt.', '..t.', '..t.', '..t.']
const PALETTE: Rows = ['.kkkkk.', 'kdyebck', 'kkvkkk.', '..kk...']
const CROSS: Rows = ['..d..', '..d..', 'ddddd', '..d..', '..d..']
const EMBLEM: Rows = ['...y...', '..yyy..', '.yyoyy.', 'yyoooyy', '.yyoyy.', '..yyy..', '...y...']
const DRAWER: Rows = ['2222222222', '2333333332', '2333yy3332', '2333333332', '2222222222']
const CUP: Rows = ['kkk', 'kwk', 'kkk']
const TEAPOT: Rows = ['.kk..', 'kdddk', 'kdddk', '.kkk.']
const NOTE_A: Rows = stamp(stamp(stamp(box(7, 8, 'p', 'r'), 3, 1, ['e']), 1, 3, ['rrrrr']), 1, 5, [
  'rrrr',
])
const NOTE_B: Rows = stamp(stamp(stamp(box(7, 8, 'q', 'r'), 3, 1, ['b']), 1, 3, ['rrrrr']), 1, 5, [
  'rrrrr',
])

/** A flowering plant ten wide; recoloured for leaves-only greenery. */
const PLANT: Rows = [
  '....ee....',
  '...eyye...',
  '....ee....',
  '.h..gh..h.',
  '.hh.gh.hh.',
  '..hhgghh..',
  '...hggh...',
  '....gg....',
  '....gg....',
  '....gg....',
]

/** A two-tile desk or table: a lit top face over a front with two drawers (or none). */
function desk(ramp: Ramp, drawers = true): Rows {
  const base = block(32, 24, 9, ramp)
  return drawers ? stamp(stamp(base, 3, 13, DRAWER), 19, 13, DRAWER) : base
}

const STEWARD_DESK = stamp(stamp(stamp(desk(WOOD), 3, 2, PAPERS), 15, 3, INKWELL), 19, 2, QUILL)
const SEAL_DESK = stamp(stamp(stamp(desk(DARK, false), 4, 2, PAPERS), 18, 2, SEAL), 12, 14, EMBLEM)

const QUEST_BOARD = paint(
  32,
  40,
  [box(4, 40, '3', 'k'), 3, 0],
  [box(4, 40, '3', 'k'), 25, 0],
  [box(28, 22, '4', 'k'), 2, 1],
  [box(24, 18, 'q', '2'), 4, 3],
  [NOTE_A, 6, 5],
  [NOTE_B, 14, 6],
  [NOTE_A, 21, 5],
  [box(18, 6, '3', 'k'), 7, 32],
  [box(6, 3, '2', 'k'), 1, 37],
  [box(6, 3, '2', 'k'), 25, 37]
)

const MAILBOX = paint(
  16,
  32,
  [box(4, 12, '3', 'k'), 6, 12],
  [box(10, 4, 't', 'k'), 3, 26],
  [box(3, 6, 'e', 'k'), 13, 0],
  [box(12, 10, 'E', 'k'), 2, 2],
  [['cccccccccc'], 3, 3],
  [['kkkkkk'], 5, 6]
)

const GATE = paint(
  32,
  32,
  [box(20, 28, '1', 'k'), 6, 4],
  [rep('ff', 27), 9, 5],
  [rep('ff', 27), 14, 5],
  [rep('ff', 27), 19, 5],
  [rep('f'.repeat(18), 2), 7, 13],
  [rep('f'.repeat(18), 2), 7, 25],
  [block(6, 32, 2, STONE), 0, 0],
  [block(6, 32, 2, STONE), 26, 0],
  [block(32, 7, 2, STONE), 0, 0]
)

const TREASURY_CHEST = paint(
  16,
  24,
  [block(16, 24, 8, { top: '4', light: '5', front: '3', shade: '2' }), 0, 0],
  [rep('oo', 22), 3, 1],
  [rep('oo', 22), 11, 1],
  [['kkkkkkkkkkkkkk'], 1, 9],
  [box(4, 4, 'y', 'k'), 6, 10],
  [['yy'], 7, 4]
)

const WRITING_DESK = stamp(stamp(stamp(desk(PALE), 4, 2, BOOK_OPEN), 18, 3, INKWELL), 24, 1, QUILL)

const ARMCHAIR = paint(
  16,
  24,
  [block(16, 24, 6, RED), 0, 0],
  [box(14, 9, 'd', 'k'), 1, 0],
  [['eeeeeeeeeeee'], 2, 1],
  [box(3, 10, 'd', 'k'), 0, 12],
  [box(3, 10, 'd', 'k'), 13, 12],
  [box(8, 5, 'e', 'k'), 4, 12]
)

const BOOKSHELF = [
  'kkkkkkkkkkkkkkkk',
  ...books('dbyvgdeybhdvyb', [6, 5, 6, 6, 4, 6, 5, 6, 6, 5, 6, 4, 6, 5]),
  ...books('vgbdyhbdevyghd', [5, 6, 6, 4, 6, 6, 5, 6, 4, 6, 6, 5, 6, 6]),
  ...books('ybdgevhbydbgvy', [6, 6, 5, 6, 6, 4, 6, 6, 5, 6, 4, 6, 6, 5]),
  ...books('gdbvyedhbyvgdb', [6, 4, 6, 6, 5, 6, 6, 6, 4, 6, 5, 6, 6, 6]),
  `k${'2'.repeat(14)}k`,
  `k${'2'.repeat(14)}k`,
  'kkkkkkkkkkkkkkkk',
]

const READING_TABLE = stamp(stamp(desk(DARK), 4, 2, BOOK_OPEN), 18, 3, PAPERS)

const GLOBE = paint(
  16,
  24,
  [box(4, 5, '2', 'k'), 6, 9],
  [block(14, 8, 2, DARK), 1, 14],
  [ellipse(12, 10, 'b', 'k'), 2, 0],
  [['hh', 'hhh'], 4, 2],
  [['h', 'hh'], 8, 5],
  [['yyyy'], 6, 9]
)

const WORKBENCH = stamp(
  stamp(stamp(desk(DARK, false), 5, 1, HAMMER), 20, 3, PAPERS),
  12,
  15,
  box(10, 6, '1', 'k')
)

const ANVIL = paint(
  16,
  16,
  [['kkkkkkkkkkkkkk..', 'kaaaaaaaaaaaakk.', 'kttttttttttttttk', '.kkkttttttkkkkk.'], 0, 2],
  [
    [
      '.....kttttk.....',
      '.....kttttk.....',
      '....kttttttk....',
      '...kttttttttk...',
      '...kssssssssk...',
      '...kkkkkkkkkk...',
    ],
    0,
    6,
  ]
)

const TOOL_RACK = paint(
  16,
  32,
  [block(16, 32, 2, DARK), 0, 0],
  [HAMMER, 2, 5],
  [WRENCH, 10, 5],
  [HAMMER, 8, 17],
  [WRENCH, 3, 18]
)

const EASEL = paint(
  16,
  32,
  [rep('23', 20), 3, 12],
  [rep('23', 20), 11, 12],
  [rep('23', 18), 7, 14],
  [['2222222222'], 3, 22],
  [box(12, 13, 'p', 'k'), 2, 1],
  [
    [
      'cccccccccc',
      'ccccccccyy',
      'cccccccccc',
      'cccccccccc',
      'chhcccchhh',
      'hhhhchhhhh',
      'hhhhhhhhhh',
      'gggghhhggg',
      'gggggggggg',
      'gggggggggg',
      'gggggggggg',
    ],
    3,
    2,
  ]
)

const PAINT_TABLE = stamp(
  stamp(stamp(desk(PALE), 4, 2, PALETTE), 17, 3, recolour(INKWELL, { b: 'd' })),
  21,
  3,
  recolour(INKWELL, { b: 'E' })
)

const SOFA = paint(
  32,
  24,
  [box(32, 10, 'E', 'k'), 0, 0],
  [['cccccccccccccccccccccccccccccc'], 1, 1],
  [block(32, 14, 2, BLUE), 0, 10],
  [box(12, 6, 'c', 'k'), 4, 10],
  [box(12, 6, 'c', 'k'), 16, 10],
  [box(4, 14, 'b', 'k'), 0, 8],
  [box(4, 14, 'b', 'k'), 28, 8]
)

const BED = paint(
  16,
  40,
  [block(16, 40, 6, WOOD), 0, 0],
  [box(16, 10, '3', 'k'), 0, 0],
  [box(10, 6, 'w', 'C'), 3, 4],
  [box(14, 22, 'E', 'k'), 1, 14],
  [['wwwwwwwwwwww'], 2, 16],
  [rep('c'.repeat(12), 1), 2, 22]
)

const MEDICINE_CABINET = paint(
  16,
  32,
  [block(16, 32, 2, LINEN), 0, 0],
  [box(12, 22, 'w', 'C'), 2, 6],
  [CROSS, 5, 8],
  [['CCCCCCCCCC'], 3, 16],
  [['kddk', 'kEEk'], 4, 12],
  [['kddk', 'kEEk'], 9, 12]
)

const MEDICINE_TABLE = stamp(
  stamp(stamp(desk(LINEN), 4, 2, CROSS), 18, 3, recolour(INKWELL, { b: 'd' })),
  23,
  3,
  recolour(INKWELL, { b: 'E' })
)

const PLANTER = paint(
  32,
  28,
  [block(32, 16, 4, SOIL), 0, 12],
  [PLANT, 2, 4],
  [recolour(PLANT, { e: 'y' }), 11, 3],
  [recolour(PLANT, { e: 'v' }), 20, 4]
)

const BENCH = paint(
  32,
  24,
  [box(32, 8, '4', 'k'), 0, 0],
  [rep('2', 1), 0, 0],
  [block(32, 16, 5, WOOD), 0, 8],
  [rep('kk', 4), 3, 20],
  [rep('kk', 4), 27, 20]
)

const FOUNTAIN = paint(
  32,
  32,
  [ellipse(32, 16, 't', 'k'), 0, 16],
  [ellipse(26, 11, 'c', 'k'), 3, 17],
  [box(6, 16, 'a', 'k'), 13, 6],
  [ellipse(12, 5, 'c', 'k'), 10, 2],
  [['w', 'w'], 16, 8]
)

const CUSHION = paint(16, 16, [ellipse(14, 9, 'v', 'k'), 1, 5], [['nnnnnn'], 5, 7], [['y'], 7, 9])

const LOW_TABLE = paint(
  32,
  20,
  [block(32, 20, 10, PURPLE), 0, 0],
  [CUP, 6, 3],
  [CUP, 12, 3],
  [TEAPOT, 21, 2]
)

const SCREEN = paint(
  32,
  32,
  [box(32, 32, 'q', '2'), 0, 0],
  [['2'.repeat(32)], 0, 3],
  [['2'.repeat(32)], 0, 28],
  [rep('2', 32), 10, 0],
  [rep('2', 32), 21, 0],
  [rep('hg', 12), 4, 5],
  [rep('hg', 12), 15, 5],
  [rep('hg', 12), 26, 5],
  [['..ii', 'ii..'], 5, 9],
  [['..ii', 'ii..'], 16, 13],
  [['..ii', 'ii..'], 27, 8]
)

const LAMP_FLOOR = paint(
  16,
  32,
  [rep('k2k', 19), 6, 8],
  [ellipse(10, 4, '3', 'k'), 3, 27],
  [
    [
      '.....kkkkkk.....',
      '....kyyyyyyk....',
      '...kyyuuuuyyk...',
      '..kyyuuuuuuyyk..',
      '..kyyuuuuuuyyk..',
      '..kooyyyyyyook..',
      '..kkkkkkkkkkkk..',
    ],
    0,
    1,
  ]
)

const PLANT_SMALL = paint(
  16,
  24,
  [rep('g', 3), 7, 13],
  [block(10, 9, 2, POT), 3, 15],
  [recolour(PLANT, { e: 'i', y: 'i' }), 3, 3]
)

const PLANT_LARGE = paint(
  16,
  32,
  [rep('23', 12), 7, 14],
  [ellipse(12, 10, 'h', 'g'), 2, 1],
  [ellipse(10, 8, 'h', 'g'), 0, 6],
  [ellipse(10, 8, 'i', 'g'), 6, 6],
  [block(12, 12, 2, POT), 2, 20]
)

const CHAIR = paint(
  16,
  24,
  [rep('2', 3), 2, 21],
  [rep('2', 3), 13, 21],
  [box(12, 12, '3', 'k'), 2, 0],
  [rep('2', 8), 5, 2],
  [rep('2', 8), 8, 2],
  [rep('2', 8), 11, 2],
  [block(14, 9, 3, WOOD), 1, 12]
)

const SHADOW: Rows = [
  '................',
  '....xxxxxxxx....',
  '..xxxxxxxxxxxx..',
  '.xxxxxxxxxxxxxx.',
  '.xxxxxxxxxxxxxx.',
  '..xxxxxxxxxxxx..',
  '....xxxxxxxx....',
  '................',
]

// An elder of the Council: a hooded, bearded figure in a robe, 16 wide, drawn facing the viewer.
const ELDER_REST: Rows = [
  '................',
  '.....kkkkkk.....',
  '....knnnnnnk....',
  '...knnDDDDnnk...',
  '...knDkDDkDnk...',
  '...knDDDDDDnk...',
  '....kwwwwwwk....',
  '...knnwwwwnnk...',
  '..knnnnwwnnnnk..',
  '..knnnnnnnnnnk..',
  '..knDDnnnnDDnk..',
  '..knnDDDDDDnnk..',
  '..knnnnnnnnnnk..',
  '..kmmmmmmmmmmk..',
  '..kmmmmmmmmmmk..',
  '...kkkkkkkkkk...',
]
const HAND_UP: Rows = ['kDk', 'kDk', 'knk']
// Leaning in: the head and shoulders dip a row toward the table.
const ELDER_LEAN: Rows = ['................', ...ELDER_REST.slice(0, 15)]
// Speaking: one hand raised beside the head, the lap hand gone.
const ELDER_SPEAK: Rows = stamp(stamp(ELDER_REST, 12, 5, HAND_UP), 10, 10, ['nn'])
// Halted: both hands up, palms out, as if to stop the room.
const ELDER_HALT: Rows = stamp(stamp(stamp(ELDER_SPEAK, 1, 5, HAND_UP), 3, 10, ['nn']), 10, 10, [
  'nn',
])
// Each elder's robe: plum, sky and sage.
const ROBES: readonly Record<string, string>[] = [{}, { n: 'E', m: 'b' }, { n: 'A', m: 's' }]

/** The Council's elders: four poses in three robes. */
function elders(): Sprite[] {
  const poses = { rest: ELDER_REST, lean: ELDER_LEAN, speak: ELDER_SPEAK, halt: ELDER_HALT }
  return Object.entries(poses).flatMap(([pose, rows]) =>
    ROBES.flatMap((robe, i) =>
      furniture(`elder-${pose}-${i}`, 'great-hall', recolour(rows, robe), 0)
    )
  )
}

/** Every piece of furniture, lamp, plant and the character shadow of the furniture atlas. */
export function furnitureSprites(): Sprite[] {
  return [
    ...furniture('steward-desk', 'great-hall', STEWARD_DESK, 8),
    ...furniture('seal-desk', 'great-hall', SEAL_DESK, 8),
    ...furniture('quest-board', 'great-hall', QUEST_BOARD, 24),
    ...furniture('mailbox', 'great-hall', MAILBOX, 16),
    ...furniture('gate', 'great-hall', GATE, 16),
    ...furniture('treasury-chest', 'great-hall', TREASURY_CHEST, 8),
    ...furniture('writing-desk', 'writing-room', WRITING_DESK, 8),
    ...furniture('armchair', 'writing-room', ARMCHAIR, 8),
    ...furniture('bookshelf', 'library', BOOKSHELF, 16),
    ...furniture('reading-table', 'library', READING_TABLE, 8),
    ...furniture('globe', 'library', GLOBE, 8),
    ...furniture('workbench', 'workshop', WORKBENCH, 8),
    ...furniture('anvil', 'workshop', ANVIL, 0),
    ...furniture('tool-rack', 'workshop', TOOL_RACK, 16),
    ...furniture('easel', 'studio', EASEL, 16),
    ...furniture('paint-table', 'studio', PAINT_TABLE, 8),
    ...furniture('sofa', 'studio', SOFA, 8),
    ...furniture('bed', 'infirmary', BED, 8),
    ...furniture('medicine-cabinet', 'infirmary', MEDICINE_CABINET, 16),
    ...furniture('medicine-table', 'infirmary', MEDICINE_TABLE, 8),
    ...furniture('planter', 'garden-room', PLANTER, 12),
    ...furniture('bench', 'garden-room', BENCH, 8),
    ...furniture('fountain', 'garden-room', FOUNTAIN, 16),
    ...furniture('cushion', 'quiet-room', CUSHION, 0),
    ...furniture('low-table', 'quiet-room', LOW_TABLE, 4),
    ...furniture('screen', 'quiet-room', SCREEN, 16),
    ...furniture('lamp-floor', 'shared', LAMP_FLOOR, 16),
    ...furniture('plant-small', 'shared', PLANT_SMALL, 8),
    ...furniture('plant-large', 'shared', PLANT_LARGE, 16),
    ...furniture('chair', 'shared', CHAIR, 8),
    ...furniture('shadow', 'shared', SHADOW, 0),
    ...elders(),
  ]
}
