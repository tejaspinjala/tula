import { z } from 'zod'

/** The three layers of a Member sprite: frame numbers in the Kenney characters sheet. */
export interface Look {
  body: number
  outfit: number
  hair: number
}

/** The characters sheet is 54 frames wide. */
export const CHAR_SHEET_COLUMNS = 54

/**
 * The fixed catalogue of character parts, as counts of choices; it mirrors guildd's
 * `LOOK_CATALOGUE` (the server refuses anything outside it).
 */
export const LOOK_CATALOGUE = {
  body: 3,
  outfitStyle: 10,
  outfitColor: 6,
  hairStyle: 2,
  hairColor: 8,
} as const

const part = (count: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(count - 1)

/** A character look as saved: one catalogue index per part. */
export const lookChoice = z.object({
  body: part(LOOK_CATALOGUE.body),
  outfitStyle: part(LOOK_CATALOGUE.outfitStyle),
  outfitColor: part(LOOK_CATALOGUE.outfitColor),
  hairStyle: part(LOOK_CATALOGUE.hairStyle),
  hairColor: part(LOOK_CATALOGUE.hairColor),
})

/** A character look: one catalogue index per part. */
export type LookChoice = z.infer<typeof lookChoice>

/** The Guild Master's own look before they customise one: a fixed id so it is the same every visit. */
export const GUILD_MASTER_ID = 'guild-master'

/** FNV-1a, so a look depends only on the id. */
function hash(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h = Math.imul(h ^ id.charCodeAt(i), 0x01000193) >>> 0
  }
  return h
}

/** The catalogue indexes a Member id seeds: stable, so the same Member always looks the same. */
export function choiceFor(id: string): LookChoice {
  const h = hash(id)
  const row = (rows: number, shift: number) => Math.floor(h / 2 ** shift) % rows
  return {
    body: row(LOOK_CATALOGUE.body, 0),
    outfitStyle: row(LOOK_CATALOGUE.outfitStyle, 4),
    outfitColor: row(LOOK_CATALOGUE.outfitColor, 8),
    hairStyle: row(LOOK_CATALOGUE.hairStyle, 12),
    hairColor: row(LOOK_CATALOGUE.hairColor, 14),
  }
}

/** The sheet frames a choice draws: layers are separate, so each part is chosen on its own. */
export function framesOf(choice: LookChoice): Look {
  return {
    body: choice.body * CHAR_SHEET_COLUMNS,
    outfit: choice.outfitStyle * CHAR_SHEET_COLUMNS + 6 + choice.outfitColor,
    hair: choice.hairStyle * CHAR_SHEET_COLUMNS + 19 + choice.hairColor,
  }
}

/** The frames a Member draws: its override when it has one, otherwise the look its id seeds. */
export function lookFor(id: string, override?: LookChoice): Look {
  return framesOf(override ?? choiceFor(id))
}
