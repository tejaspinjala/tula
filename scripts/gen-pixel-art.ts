/**
 * Draws Guildhall's own pixel art with the token palette: the 24x24 wood 9-slice frame, a
 * four-frame Member walking sheet and three 8x8 icon masks. Run `bun scripts/gen-pixel-art.ts`
 * after changing `tokens.css`; the output is committed under `apps/web/src/assets/pixel`.
 */
import { deflateSync } from 'node:zlib'

/** Where the generated pixel art is committed. */
export const ART_DIR = new URL('../apps/web/src/assets/pixel', import.meta.url).pathname

const TOKENS = new URL('../apps/web/src/styles/tokens.css', import.meta.url).pathname

type Rgba = readonly [number, number, number, number]
const CLEAR: Rgba = [0, 0, 0, 0]

/** The day palette read from `tokens.css` (the first definition of each `--px-*` colour). */
async function palette(): Promise<Record<string, Rgba>> {
  const css = await Bun.file(TOKENS).text()
  const out: Record<string, Rgba> = {}
  for (const m of css.matchAll(/(--px-[a-z0-9-]+):\s*#([0-9a-fA-F]{6})\s*;/g)) {
    const name = m[1]
    const hex = m[2]
    if (name && hex && !(name in out)) {
      out[name] = [
        Number.parseInt(hex.slice(0, 2), 16),
        Number.parseInt(hex.slice(2, 4), 16),
        Number.parseInt(hex.slice(4, 6), 16),
        255,
      ]
    }
  }
  return out
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  const body = new Uint8Array(4 + data.length)
  body.set(new TextEncoder().encode(type), 0)
  body.set(data, 4)
  out.set(body, 4)
  view.setUint32(8 + data.length, crc32(body))
  return out
}

/** Encodes RGBA pixels (row-major) as a PNG. */
function encodePng(width: number, height: number, pixels: readonly Rgba[]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 4))
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 4)
    raw[row] = 0
    for (let x = 0; x < width; x++) {
      raw.set(pixels[y * width + x] ?? CLEAR, row + 1 + x * 4)
    }
  }
  const header = new Uint8Array(13)
  const view = new DataView(header.buffer)
  view.setUint32(0, width)
  view.setUint32(4, height)
  header.set([8, 6, 0, 0, 0], 8)
  const parts = [
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const part of parts) {
    out.set(part, at)
    at += part.length
  }
  return out
}

type Canvas = { width: number; height: number; px: Rgba[] }

function canvas(width: number, height: number): Canvas {
  return { width, height, px: new Array<Rgba>(width * height).fill(CLEAR) }
}

function put(c: Canvas, x: number, y: number, color: Rgba): void {
  if (x >= 0 && y >= 0 && x < c.width && y < c.height) {
    c.px[y * c.width + x] = color
  }
}

function at(c: Canvas, x: number, y: number): Rgba {
  return c.px[y * c.width + x] ?? CLEAR
}

function rect(c: Canvas, x: number, y: number, w: number, h: number, color: Rgba): void {
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      put(c, x + i, y + j, color)
    }
  }
}

/** Outlines every opaque shape with a one-pixel ring of `ink`. */
function outline(c: Canvas, ink: Rgba): void {
  const marked: [number, number][] = []
  for (let y = 0; y < c.height; y++) {
    for (let x = 0; x < c.width; x++) {
      if (at(c, x, y)[3] === 0) {
        const near = [
          [x - 1, y],
          [x + 1, y],
          [x, y - 1],
          [x, y + 1],
        ].some(([nx, ny]) => nx !== undefined && ny !== undefined && at(c, nx, ny)[3] > 0)
        if (near) {
          marked.push([x, y])
        }
      }
    }
  }
  for (const [x, y] of marked) {
    put(c, x, y, ink)
  }
}

function woodFrame(p: Record<string, Rgba>): Uint8Array {
  const c = canvas(24, 24)
  const color = (name: string): Rgba => p[name] ?? CLEAR
  for (let y = 0; y < 24; y++) {
    for (let x = 0; x < 24; x++) {
      const d = Math.min(x, y, 23 - x, 23 - y)
      if (d > 7) {
        continue
      }
      // Which side this pixel belongs to: lit (top, left) or shaded (bottom, right).
      const lit = Math.min(x, y) <= Math.min(23 - x, 23 - y)
      let name = 'wood-500'
      if (d === 0 || d === 7) {
        name = 'ink'
      } else if (d === 1) {
        name = lit ? 'wood-300' : 'wood-700'
      } else if (d === 6) {
        name = lit ? 'wood-700' : 'wood-300'
      } else if ((x + y) % 5 === 0) {
        name = 'wood-700'
      } else if ((x * 3 + y * 7) % 11 === 0) {
        name = 'wood-300'
      }
      put(c, x, y, color(`--px-${name}`))
    }
  }
  for (const [rx, ry] of [
    [3, 3],
    [19, 3],
    [3, 19],
    [19, 19],
  ] as const) {
    rect(c, rx, ry, 2, 2, color('--px-gold-500'))
    put(c, rx + 1, ry + 1, color('--px-gold-700'))
  }
  return encodePng(c.width, c.height, c.px)
}

function walker(p: Record<string, Rgba>): Uint8Array {
  const color = (name: string): Rgba => p[`--px-${name}`] ?? CLEAR
  const sheet = canvas(64, 16)
  // Leg rows per frame: apart, together, apart (other foot), together.
  const legs = [
    [4, 9],
    [6, 7],
    [3, 10],
    [6, 7],
  ] as const
  for (let f = 0; f < 4; f++) {
    const frame = canvas(16, 16)
    const bob = f % 2
    rect(frame, 5, 2 + bob, 6, 5, color('wood-100'))
    rect(frame, 5, 2 + bob, 6, 2, color('wood-900'))
    rect(frame, 4, 7 + bob, 8, 4, color('sky-700'))
    rect(frame, 4, 8 + bob, 1, 2, color('wood-100'))
    rect(frame, 11, 8 + bob, 1, 2, color('wood-100'))
    const [a, b] = legs[f] ?? [6, 7]
    rect(frame, a, 11 + bob, 2, 3 - bob, color('wood-700'))
    rect(frame, b + 1, 11 + bob, 2, 3 - bob, color('wood-700'))
    outline(frame, color('ink'))
    for (let y = 0; y < 16; y++) {
      for (let x = 0; x < 16; x++) {
        put(sheet, f * 16 + x, y, at(frame, x, y))
      }
    }
  }
  return encodePng(sheet.width, sheet.height, sheet.px)
}

const ICONS: Record<string, readonly string[]> = {
  'icon-star.png': [
    '...##...',
    '...##...',
    '########',
    '.######.',
    '..####..',
    '.######.',
    '.##..##.',
    '##....##',
  ],
  'icon-warn.png': [
    '...##...',
    '..####..',
    '..####..',
    '.##..##.',
    '.##..##.',
    '########',
    '##....##',
    '########',
  ],
  'hatch.png': [
    '#...#...',
    '.#...#..',
    '..#...#.',
    '...#...#',
    '#...#...',
    '.#...#..',
    '..#...#.',
    '...#...#',
  ],
  'checker.png': [
    '#.#.#.#.',
    '.#.#.#.#',
    '#.#.#.#.',
    '.#.#.#.#',
    '#.#.#.#.',
    '.#.#.#.#',
    '#.#.#.#.',
    '.#.#.#.#',
  ],
  'icon-pause.png': [
    '........',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '.##..##.',
    '........',
  ],
}

function icon(rows: readonly string[]): Uint8Array {
  const c = canvas(8, 8)
  rows.forEach((row, y) => {
    for (let x = 0; x < 8; x++) {
      if (row[x] === '#') {
        put(c, x, y, [0, 0, 0, 255])
      }
    }
  })
  return encodePng(c.width, c.height, c.px)
}

/** Draws every asset: file name to PNG bytes. Deterministic for a given `tokens.css`. */
export async function renderArt(): Promise<Map<string, Uint8Array>> {
  const p = await palette()
  const out = new Map<string, Uint8Array>()
  out.set('wood-frame.png', woodFrame(p))
  out.set('walker.png', walker(p))
  for (const [name, rows] of Object.entries(ICONS)) {
    out.set(name, icon(rows))
  }
  return out
}

if (import.meta.main) {
  for (const [name, png] of await renderArt()) {
    await Bun.write(`${ART_DIR}/${name}`, png)
  }
}
