import { type CSSProperties, useState } from 'react'
import { allSprites, type Frame, packAtlases } from '../../game/art/atlas'
import { type Group, STYLES, type Style } from '../../game/art/types'
import { Frame as PixelFrame } from './Frame'
import { PixelButton } from './PixelButton'

type VarStyle = CSSProperties & Record<`--${string}`, string>

interface Placed {
  atlas: 'interiors' | 'furniture'
  atlasHeight: number
  frame: Frame
  group: Group
}

function index(): Map<string, Placed> {
  const sprites = new Map(allSprites().map((s) => [s.name, s]))
  const out = new Map<string, Placed>()
  for (const atlas of packAtlases()) {
    for (const [name, frame] of Object.entries(atlas.frames)) {
      const group = sprites.get(name)?.group
      if (group) {
        out.set(name, { atlas: atlas.name, atlasHeight: atlas.height, frame, group })
      }
    }
  }
  return out
}

const FRAMES = index()

/** One atlas frame drawn from the packed PNG at (`x`, `y`) in tile pixels when positioned. */
function Tile({ name, x, y }: { name: string; x?: number; y?: number }) {
  const p = FRAMES.get(name)
  if (!p) {
    return null
  }
  const { frame: f } = p
  const style: VarStyle = {
    width: `calc(var(--tile-px) * ${f.w})`,
    height: `calc(var(--tile-px) * ${f.h})`,
    backgroundImage: `url(/game/${p.atlas}.png)`,
    backgroundSize: `calc(var(--tile-px) * 256) calc(var(--tile-px) * ${p.atlasHeight})`,
    backgroundPosition: `calc(var(--tile-px) * ${-f.x}) calc(var(--tile-px) * ${-f.y})`,
  }
  if (x !== undefined && y !== undefined) {
    style.position = 'absolute'
    style.left = `calc(var(--tile-px) * ${x})`
    style.top = `calc(var(--tile-px) * ${y})`
  }
  return <span role="img" aria-label={name} className="px-tile" style={style} />
}

type Item = readonly [name: string, col: number, row: number]

interface Layout {
  floor:
    | 'floor-wood'
    | 'floor-wood-b'
    | 'floor-stone'
    | 'floor-stone-b'
    | 'floor-tile'
    | 'floor-tile-b'
  rug?: boolean
  items: readonly Item[]
}

/** A small room per style: back wall of three rows, a doorway and mat, windows, then furniture. */
const ROOMS: Record<Style, Layout> = {
  'great-hall': {
    floor: 'floor-stone',
    items: [
      ['quest-board', 0, 3],
      ['gate', 5, 3],
      ['mailbox', 7, 3],
      ['steward-desk', 1, 5],
      ['seal-desk', 4, 5],
      ['treasury-chest', 7, 5],
    ],
  },
  'writing-room': {
    floor: 'floor-wood',
    rug: true,
    items: [
      ['writing-desk', 1, 4],
      ['armchair', 5, 5],
      ['plant-small', 7, 3],
      ['lamp-floor', 0, 3],
    ],
  },
  library: {
    floor: 'floor-wood-b',
    items: [
      ['bookshelf', 1, 3],
      ['bookshelf', 5, 3],
      ['reading-table', 3, 5],
      ['globe', 6, 5],
      ['chair', 2, 6],
    ],
  },
  workshop: {
    floor: 'floor-stone-b',
    items: [
      ['workbench', 1, 4],
      ['anvil', 5, 5],
      ['tool-rack', 6, 3],
      ['lamp-floor', 0, 3],
    ],
  },
  studio: {
    floor: 'floor-tile',
    items: [
      ['easel', 1, 4],
      ['paint-table', 4, 5],
      ['sofa', 5, 3],
      ['plant-large', 0, 5],
    ],
  },
  infirmary: {
    floor: 'floor-tile-b',
    items: [
      ['bed', 0, 4],
      ['medicine-cabinet', 5, 3],
      ['medicine-table', 4, 5],
      ['plant-small', 7, 4],
    ],
  },
  'garden-room': {
    floor: 'floor-stone-b',
    items: [
      ['planter', 0, 3],
      ['fountain', 3, 5],
      ['bench', 5, 3],
      ['plant-large', 7, 5],
    ],
  },
  'quiet-room': {
    floor: 'floor-wood-b',
    rug: true,
    items: [
      ['screen', 5, 3],
      ['low-table', 3, 4],
      ['cushion', 2, 5],
      ['cushion', 5, 5],
      ['lamp-floor', 0, 3],
      ['plant-large', 7, 4],
    ],
  },
}

const COLS = 8
const ROWS = 7

/** A composed room: floor, rug, the three-row wall, doorway, windows, furniture, shadows, then top layers. */
function RoomPreview({ style }: { style: Style }) {
  const room = ROOMS[style]
  const cells: React.ReactNode[] = []
  for (let r = 3; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      cells.push(<Tile key={`f${c}-${r}`} name={room.floor} x={c * 16} y={r * 16} />)
    }
  }
  if (room.rug) {
    const slices = [
      ['tl', 't', 't', 'tr'],
      ['l', 'c', 'c', 'r'],
      ['bl', 'b', 'b', 'br'],
    ]
    slices.forEach((row, j) => {
      row.forEach((s, i) => {
        const x = (2 + i) * 16
        const y = (4 + j) * 16
        cells.push(<Tile key={`rug${x}-${y}`} name={`rug-red-${s}`} x={x} y={y} />)
      })
    })
  }
  const parts = ['top', 'face-1', 'face-2']
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < COLS; c++) {
      cells.push(
        <Tile key={`w${c}-${r}`} name={`wall-${style}-${parts[r]}`} x={c * 16} y={r * 16} />
      )
    }
  }
  cells.push(
    <Tile key="door" name="doorway" x={48} y={16} />,
    <Tile key="mat" name="door-mat" x={48} y={48} />
  )
  cells.push(
    <Tile key="win1" name="window" x={16} y={20} />,
    <Tile key="win2" name="window" x={80} y={20} />
  )
  cells.push(<Tile key="pic" name="picture-a" x={112} y={20} />)
  const sorted = [...room.items].sort((a, b) => a[2] - b[2])
  sorted.forEach(([name, col, row]) => {
    const f = FRAMES.get(name)
    if (f) {
      cells.push(
        <Tile
          key={`s${name}${col}${row}`}
          name="shadow"
          x={col * 16 + (f.frame.w - 16) / 2}
          y={row * 16 + f.frame.h - 6}
        />
      )
      cells.push(<Tile key={`b${name}${col}${row}`} name={name} x={col * 16} y={row * 16} />)
    }
  })
  sorted.forEach(([name, col, row]) => {
    const top = FRAMES.get(`${name}~top`)
    if (top) {
      cells.push(
        <Tile
          key={`t${name}${col}${row}`}
          name={`${name}~top`}
          x={col * 16}
          y={row * 16 - top.frame.h}
        />
      )
    }
  })
  return (
    <figure
      className="px-room"
      aria-label={`${style} preview`}
      style={{
        width: `calc(var(--tile-px) * ${COLS * 16})`,
        height: `calc(var(--tile-px) * ${ROWS * 16})`,
      }}
    >
      {cells}
    </figure>
  )
}

const GROUPS: readonly Group[] = [...STYLES, 'shared']

function title(group: Group): string {
  return group === 'shared'
    ? 'Shared: floors, rugs, lamps, plants, shadow'
    : group.replace('-', ' ')
}

/**
 * The dev-only tileset board: every frame of the interiors and furniture atlases grouped by room
 * style, with a composed room per style and a 1x, 2x or 3x scale.
 */
export function Tileset() {
  const [scale, setScale] = useState(2)
  const style: VarStyle = { '--tile-px': `${scale * 0.0625}rem` }
  return (
    <PixelFrame variant="paper" className="px-sink-wide">
      <h2 className="px-sink-title">Interiors tileset</h2>
      <div className="px-sink-row">
        {[1, 2, 3].map((n) => (
          <PixelButton key={n} onClick={() => setScale(n)} aria-pressed={scale === n}>
            {n}x
          </PixelButton>
        ))}
      </div>
      <div style={style}>
        {GROUPS.map((group) => (
          <section key={group} className="px-tileset-group" aria-label={title(group)}>
            <h3 className="px-sink-title">{title(group)}</h3>
            {group !== 'shared' && <RoomPreview style={group} />}
            <ul className="px-tileset-list">
              {[...FRAMES.entries()]
                .filter(([, p]) => p.group === group)
                .map(([name]) => (
                  <li key={name} className="px-tileset-cell">
                    <Tile name={name} />
                    <span className="px-sink-note">{name}</span>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </PixelFrame>
  )
}
