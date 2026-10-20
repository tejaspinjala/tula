import { z } from 'zod'

/**
 * The fixed catalogue of character parts (Kenney CC0 layers now; PixelLab parts later, ADR-0009).
 * Counts are of choices per part; the web client holds the frames each choice draws. A saved look
 * is only ever a set of indexes inside these counts, never a free-form value.
 */
export const LOOK_CATALOGUE = {
  /** Skin tones (body rows of the characters sheet). */
  body: 3,
  /** Outfit styles (rows). */
  outfitStyle: 10,
  /** Outfit colours (columns). */
  outfitColor: 6,
  /** Hair styles (rows). */
  hairStyle: 2,
  /** Hair colours (columns). */
  hairColor: 8,
} as const

const part = (count: number) =>
  z
    .number()
    .int()
    .min(0)
    .max(count - 1)

/** A character look: one catalogue index per part. Unknown parts and out-of-range indexes are refused. */
export const characterLook = z.strictObject({
  body: part(LOOK_CATALOGUE.body),
  outfitStyle: part(LOOK_CATALOGUE.outfitStyle),
  outfitColor: part(LOOK_CATALOGUE.outfitColor),
  hairStyle: part(LOOK_CATALOGUE.hairStyle),
  hairColor: part(LOOK_CATALOGUE.hairColor),
})

/** A validated character look. */
export type CharacterLook = z.infer<typeof characterLook>
