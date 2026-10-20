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

/** The catalogue indexes a Member id seeds (stub). */
export function choiceFor(_id: string): LookChoice {
  return { body: 0, outfitStyle: 0, outfitColor: 0, hairStyle: 0, hairColor: 0 }
}

/** The sheet frames a choice draws (stub). */
export function framesOf(_choice: LookChoice): Look {
  return { body: 0, outfit: 0, hair: 0 }
}

/** The frames a Member draws: its override when it has one, otherwise the look its id seeds (stub). */
export function lookFor(_id: string, _override?: LookChoice): Look {
  return { body: 0, outfit: 0, hair: 0 }
}
