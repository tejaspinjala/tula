/** The three layers of a Member sprite: frame numbers in the Kenney characters sheet. */
export interface Look {
  body: number
  outfit: number
  hair: number
}

/** The characters sheet is 54 frames wide. */
export const CHAR_SHEET_COLUMNS = 54

/** Picks a Member's body, outfit and hair layers from its id (stable; custom looks come later). */
export function lookFor(_id: string): Look {
  return { body: 0, outfit: 0, hair: 0 }
}
