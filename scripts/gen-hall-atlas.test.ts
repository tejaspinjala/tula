import { expect, test } from 'bun:test'
import { inflateSync } from 'node:zlib'
import { validateSprites } from '../apps/web/src/game/art/atlas'
import { ATLAS_DIR, renderHallAtlases } from './gen-hall-atlas'
import { palette } from './gen-pixel-art'

interface Decoded {
  width: number
  height: number
  rgba: Uint8Array
}

/** Reads back a PNG written by our encoder (8-bit RGBA, filter 0), independently of the encoder. */
function decode(png: Uint8Array): Decoded {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength)
  const width = view.getUint32(16)
  const height = view.getUint32(20)
  const idat: Uint8Array[] = []
  let at = 8
  while (at < png.length) {
    const len = view.getUint32(at)
    const type = new TextDecoder().decode(png.slice(at + 4, at + 8))
    if (type === 'IDAT') {
      idat.push(png.slice(at + 8, at + 8 + len))
    }
    at += 12 + len
  }
  const joined = new Uint8Array(idat.reduce((n, p) => n + p.length, 0))
  let o = 0
  for (const part of idat) {
    joined.set(part, o)
    o += part.length
  }
  const raw = inflateSync(joined)
  const rgba = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    expect(raw[y * (1 + width * 4)]).toBe(0)
    rgba.set(raw.subarray(y * (1 + width * 4) + 1, (y + 1) * (1 + width * 4)), y * width * 4)
  }
  return { width, height, rgba }
}

interface FrameMap {
  image: string
  size: { w: number; h: number }
  frames: Record<string, { x: number; y: number; w: number; h: number }>
}

const STYLES = [
  'great-hall',
  'writing-room',
  'library',
  'workshop',
  'studio',
  'infirmary',
  'garden-room',
  'quiet-room',
] as const

const FURNITURE = [
  'steward-desk',
  'seal-desk',
  'quest-board',
  'mailbox',
  'gate',
  'treasury-chest',
  'writing-desk',
  'armchair',
  'bookshelf',
  'reading-table',
  'globe',
  'workbench',
  'anvil',
  'tool-rack',
  'easel',
  'paint-table',
  'sofa',
  'bed',
  'medicine-cabinet',
  'medicine-table',
  'planter',
  'bench',
  'fountain',
  'cushion',
  'low-table',
  'screen',
  'lamp-floor',
  'plant-small',
  'plant-large',
  'chair',
]

const TALL = [
  'steward-desk',
  'seal-desk',
  'quest-board',
  'mailbox',
  'gate',
  'treasury-chest',
  'bookshelf',
  'easel',
  'bed',
  'medicine-cabinet',
  'planter',
  'lamp-floor',
]

const SHARED = [
  'shadow',
  'floor-wood',
  'floor-wood-b',
  'floor-stone',
  'floor-stone-b',
  'floor-tile',
  'floor-tile-b',
  'rug-red-tl',
  'rug-red-t',
  'rug-red-tr',
  'rug-red-l',
  'rug-red-c',
  'rug-red-r',
  'rug-red-bl',
  'rug-red-b',
  'rug-red-br',
  'window',
  'shelf-wall',
  'picture-a',
  'picture-b',
  'sconce',
  'doorway',
  'door-mat',
]

async function frameMaps(): Promise<Record<string, FrameMap>> {
  const out = await renderHallAtlases()
  const maps: Record<string, FrameMap> = {}
  for (const name of ['interiors', 'furniture']) {
    const bytes = out.get(`${name}.json`)
    expect(bytes).toBeDefined()
    maps[name] = JSON.parse(new TextDecoder().decode(bytes))
  }
  return maps
}

test('the sprite data is sound: equal row widths and only palette characters', () => {
  expect(validateSprites()).toEqual([])
})

test('running the generator twice gives byte-identical atlases', async () => {
  const a = await renderHallAtlases()
  const b = await renderHallAtlases()
  expect([...a.keys()].sort()).toEqual([
    'furniture.json',
    'furniture.png',
    'interiors.json',
    'interiors.png',
  ])
  for (const [name, bytes] of a) {
    expect(Buffer.from(bytes).equals(Buffer.from(b.get(name) ?? new Uint8Array()))).toBe(true)
  }
})

test('every frame sits inside its atlas and every pixel colour is in the palette', async () => {
  const out = await renderHallAtlases()
  const tokens = await palette()
  const allowed = new Set<string>()
  for (const [name, [r, g, b]] of Object.entries(tokens)) {
    if (name.startsWith('--px-')) {
      allowed.add(`${r},${g},${b},255`)
    }
  }
  const ink = tokens['--px-ink'] ?? [0, 0, 0, 255]
  allowed.add(`${ink[0]},${ink[1]},${ink[2]},96`)
  allowed.add('0,0,0,0')
  const maps = await frameMaps()
  for (const [name, map] of Object.entries(maps)) {
    const png = decode(out.get(`${name}.png`) ?? new Uint8Array())
    expect({ w: png.width, h: png.height }).toEqual(map.size)
    expect(Object.keys(map.frames).length).toBeGreaterThan(0)
    for (const f of Object.values(map.frames)) {
      expect(f.x >= 0 && f.y >= 0 && f.x + f.w <= png.width && f.y + f.h <= png.height).toBe(true)
    }
    for (let i = 0; i < png.rgba.length; i += 4) {
      const key = `${png.rgba[i]},${png.rgba[i + 1]},${png.rgba[i + 2]},${png.rgba[i + 3]}`
      if (!allowed.has(key)) {
        throw new Error(`${name}.png pixel ${i / 4} has colour ${key} outside the palette`)
      }
    }
  }
})

test('frames do not overlap inside an atlas', async () => {
  const maps = await frameMaps()
  for (const map of Object.values(maps)) {
    const taken = new Set<string>()
    for (const f of Object.values(map.frames)) {
      for (let y = f.y; y < f.y + f.h; y++) {
        for (let x = f.x; x < f.x + f.w; x++) {
          expect(taken.has(`${x},${y}`)).toBe(false)
          taken.add(`${x},${y}`)
        }
      }
    }
  }
})

test('it covers the Great Hall, the seven room styles, floors, rugs, lamps, plants and the 16 by 8 shadow', async () => {
  const maps = await frameMaps()
  const all: Record<string, { w: number; h: number }> = {}
  for (const map of Object.values(maps)) {
    Object.assign(all, map.frames)
  }
  for (const name of [...SHARED, ...FURNITURE]) {
    expect(all[name]).toBeDefined()
  }
  for (const name of TALL) {
    expect(all[`${name}~top`]).toBeDefined()
  }
  for (const style of STYLES) {
    for (const part of ['top', 'face-1', 'face-2']) {
      expect(all[`wall-${style}-${part}`]).toEqual(expect.objectContaining({ w: 16, h: 16 }))
    }
  }
  expect(all.shadow).toEqual(expect.objectContaining({ w: 16, h: 8 }))
  expect(all['floor-wood']).toEqual(expect.objectContaining({ w: 16, h: 16 }))
})

test('the committed atlases are exactly what the generator draws', async () => {
  const out = await renderHallAtlases()
  expect(out.size).toBeGreaterThan(0)
  for (const [name, bytes] of out) {
    const committed = new Uint8Array(await Bun.file(`${ATLAS_DIR}/${name}`).arrayBuffer())
    expect(Buffer.from(committed).equals(Buffer.from(bytes))).toBe(true)
  }
})
