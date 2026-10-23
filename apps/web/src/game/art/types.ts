import type { Rows } from './compose'

/** The Great Hall and the seven room styles, in the order the Kitchen Sink shows them. */
export const STYLES = [
  'great-hall',
  'writing-room',
  'library',
  'workshop',
  'studio',
  'infirmary',
  'garden-room',
  'quiet-room',
] as const

/** A room style id. */
export type Style = (typeof STYLES)[number]

/** Where a sprite is shown in the Kitchen Sink: a room style, or the pieces every room shares. */
export type Group = Style | 'shared'

/** One sprite as authored: palette-character rows, plus the atlas it is packed into. */
export interface Sprite {
  name: string
  group: Group
  atlas: 'interiors' | 'furniture'
  rows: Rows
}

/**
 * A furniture piece as authored in one map: the first `topRows` rows are its top layer (drawn above
 * characters), the rest its footprint (drawn with them, y-sorted on the bottom edge).
 */
export function furniture(name: string, group: Group, rows: Rows, topRows: number): Sprite[] {
  const base: Sprite = { name, group, atlas: 'furniture', rows: rows.slice(topRows) }
  if (topRows === 0) {
    return [base]
  }
  return [base, { name: `${name}~top`, group, atlas: 'furniture', rows: rows.slice(0, topRows) }]
}
