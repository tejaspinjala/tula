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

/** Packs every sprite into the interiors and furniture atlases. */
export function packAtlases(): PackedAtlas[] {
  return []
}

/** The problems found in the sprite data (ragged rows, unknown palette characters); empty when sound. */
export function validateSprites(): string[] {
  return ['not implemented']
}
