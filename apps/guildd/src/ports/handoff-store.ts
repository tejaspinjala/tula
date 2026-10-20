import { z } from 'zod'
import { hashBytes } from './object-store'

const artifactHash = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'an artifact hash is 64 lowercase hex characters')

/** One piece of evidence a Handoff cites: an artifact (by hash) or an Archive note (by id). */
export const evidenceRef = z.strictObject({
  kind: z.enum(['artifact', 'note']),
  ref: z.string().min(1).max(64),
})

/**
 * The schema-checked packet an agent run ends with: goal, done-condition, evidence, open items and
 * artifact references. A Handoff marked `met` must cite evidence.
 */
export const handoff = z
  .strictObject({
    goal: z.string().trim().min(1).max(2000),
    doneCondition: z.string().trim().min(1).max(2000),
    met: z.boolean(),
    evidence: z.array(evidenceRef).max(50),
    openItems: z.array(z.string().trim().min(1).max(500)).max(50),
    artifacts: z.array(artifactHash).max(50),
  })
  .superRefine((h, ctx) => {
    if (h.met && h.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'a Handoff marked met must cite at least one evidence reference',
      })
    }
  })

/** A validated Handoff. */
export type Handoff = z.infer<typeof handoff>

/** SHA-256 (lowercase hex) of the Handoff's canonical JSON; what missives carry instead of content. */
export function hashHandoff(value: Handoff): string {
  return hashBytes(new TextEncoder().encode(JSON.stringify(value)))
}

/** A Handoff as stored for one Quest attempt. */
export interface StoredHandoff {
  handoff: Handoff
  hash: string
  memberId: string
}

/**
 * Port for Handoffs and the artifacts a Quest holds. A Handoff is insert-only, one per Quest and
 * attempt, first writer wins. Every write appends an event carrying ids and hashes only.
 */
export interface HandoffStore {
  /**
   * Records the Handoff of `attempt`. Idempotent: if one exists the stored one is returned with
   * `created: false` and nothing changes, so the caller compares hashes to spot a conflicting retry.
   */
  record(
    guildId: string,
    questId: string,
    attempt: number,
    memberId: string,
    value: Handoff
  ): Promise<{ stored: StoredHandoff; created: boolean }>
  /** The Handoff of one attempt, or null. */
  get(guildId: string, questId: string, attempt: number): Promise<StoredHandoff | null>
  /**
   * Notes that the Quest holds the artifact `hash` (idempotent). A store backed by the artifact
   * ledger also records the guild's artifact row and `artifact.stored` event in the same step.
   */
  attach(guildId: string, questId: string, hash: string, size: number): Promise<void>
  /** Whether the Quest holds the artifact `hash`. */
  holds(guildId: string, questId: string, hash: string): Promise<boolean>
}
