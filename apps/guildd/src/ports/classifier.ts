import { z } from 'zod'
import { memberRank } from '../guild-config'

/** Data classes, least to most restricted. Private work may only touch private-eligible providers. */
export const DATA_CLASSES = ['public', 'internal', 'private'] as const
/** A Quest's data class. */
export const dataClass = z.enum(DATA_CLASSES)
/** A data class. */
export type DataClass = z.infer<typeof dataClass>

/** What a classifier may say about a free-text goal. It proposes; routing code decides. */
export const classification = z.object({
  hallId: z.string().min(1).max(64),
  rank: memberRank,
  dataClass,
})
/** A classifier's proposal for a free-text goal. */
export type Classification = z.infer<typeof classification>

/** The Halls a classifier may choose among. */
export interface ClassifierHall {
  id: string
  kind: 'work' | 'private'
}

/**
 * Port for routing step 1 on free-text goals (ADR-0006). Output is untrusted and advisory: routing only
 * takes its Hall (a known unlocked one) and logs its claimed class; free text routes as `private`
 * unless the Guild Master set a class, so a claim never lowers a class. It never picks a provider. Implementations may throw; routing then uses the deterministic fallback.
 */
export interface Classifier {
  classify(input: { goal: string; halls: readonly ClassifierHall[] }): Promise<Classification>
}
