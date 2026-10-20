/** The three layers of a Member sprite: frame numbers in the Kenney characters sheet. */
export interface Look {
  body: number
  outfit: number
  hair: number
}

/** The characters sheet is 54 frames wide. */
export const CHAR_SHEET_COLUMNS = 54

/** FNV-1a, so a look depends only on the id. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  }
  return h
}

/**
 * Picks a Member's body, outfit and hair layers from its id (stable; the layers are separate so
 * a Guild Master character can later choose each one).
 */
export function lookFor(id: string): Look {
  const h = hash(id)
  const row = (rows: number, shift: number) => Math.floor(h / 2 ** shift) % rows
  return {
    body: row(3, 0) * CHAR_SHEET_COLUMNS,
    outfit: row(10, 4) * CHAR_SHEET_COLUMNS + 6 + row(6, 8),
    hair: row(2, 12) * CHAR_SHEET_COLUMNS + 19 + row(8, 14),
  }
}
