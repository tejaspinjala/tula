import { furnitureSprites } from './furniture'
import { interiorSprites } from './interiors'
import { PALETTE } from './palette'
import type { Sprite } from './types'

/** One frame of an atlas: where a sprite sits in the packed PNG. */
export interface Frame {
  x: number
  y: number
  w: number
  h: number
}

/** A packed atlas before encoding: the frame map and the palette-char pixel rows of the sheet. */
export interface PackedAtlas {
  name: 'interiors' | 'furniture'
  width: number
  height: number
  frames: Record<string, Frame>
  rows: readonly string[]
}

/** Every sprite of the three-quarter tileset, in authoring order. */
export function allSprites(): Sprite[] {
  return [...interiorSprites(), ...furnitureSprites()]
}

/** The width of every atlas sheet; sprites are packed in shelves from the tallest down. */
const ATLAS_WIDTH = 256

/** One pixel of gap around every frame is not needed (Phaser crops by frame), so frames are butted. */
function pack(name: PackedAtlas['name'], sprites: readonly Sprite[]): PackedAtlas {
  const ordered = [...sprites].sort(
    (a, b) => b.rows.length - a.rows.length || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  )
  const frames: Record<string, Frame> = {}
  const placed: { sprite: Sprite; x: number; y: number }[] = []
  let x = 0
  let y = 0
  let shelf = 0
  for (const sprite of ordered) {
    const w = sprite.rows[0]?.length ?? 0
    const h = sprite.rows.length
    if (x + w > ATLAS_WIDTH) {
      x = 0
      y += shelf
      shelf = 0
    }
    frames[sprite.name] = { x, y, w, h }
    placed.push({ sprite, x, y })
    x += w
    shelf = Math.max(shelf, h)
  }
  const height = y + shelf
  const sheet = Array.from({ length: height }, () => '.'.repeat(ATLAS_WIDTH).split(''))
  for (const { sprite, x: ox, y: oy } of placed) {
    sprite.rows.forEach((row, j) => {
      const line = sheet[oy + j]
      if (line) {
        for (let i = 0; i < row.length; i++) {
          line[ox + i] = row[i] ?? '.'
        }
      }
    })
  }
  return { name, width: ATLAS_WIDTH, height, frames, rows: sheet.map((r) => r.join('')) }
}

/** Packs every sprite into the interiors and furniture atlases. */
export function packAtlases(): PackedAtlas[] {
  const sprites = allSprites()
  return (['interiors', 'furniture'] as const).map((name) =>
    pack(
      name,
      sprites.filter((s) => s.atlas === name)
    )
  )
}

/** The problems found in the sprite data (ragged rows, unknown palette characters, repeats); empty when sound. */
export function validateSprites(): string[] {
  const problems: string[] = []
  const seen = new Set<string>()
  for (const s of allSprites()) {
    if (seen.has(s.name)) {
      problems.push(`${s.name}: defined twice`)
    }
    seen.add(s.name)
    const w = s.rows[0]?.length ?? 0
    if (w === 0 || s.rows.length === 0) {
      problems.push(`${s.name}: empty`)
    }
    s.rows.forEach((row, y) => {
      if (row.length !== w) {
        problems.push(`${s.name}: row ${y} is ${row.length} wide, not ${w}`)
      }
      for (const ch of row) {
        if (ch !== '.' && !(ch in PALETTE)) {
          problems.push(`${s.name}: row ${y} uses unknown palette character ${ch}`)
        }
      }
    })
  }
  return problems
}
