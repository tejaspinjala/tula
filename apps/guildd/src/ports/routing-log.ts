import { z } from 'zod'
import { memberRank } from '../guild-config'
import { dataClass } from './classifier'

/** Largest page a {@link RoutingLog.list} call returns. */
export const MAX_ROUTING_PAGE = 100

/** Why work is blocked rather than routed. */
export const BLOCK_REASONS = [
  'hall_not_found',
  'hall_locked',
  'private_provider_unavailable',
  'budget_exhausted',
  'no_provider_available',
] as const
/** Why work was blocked. */
export type BlockReason = (typeof BLOCK_REASONS)[number]

/** One routing decision as logged (training data for the future Oracle; ADR-0006). */
export const routingEntry = z.object({
  /** Caller-chosen idempotency key: a retried decision with the same key logs once. */
  decisionKey: z.string().min(1).max(200),
  /** How step 1 got Hall, rank and class: from the template, the classifier, or the fallback. */
  source: z.enum(['template', 'classifier', 'fallback']),
  /** SHA-256 of a free-text goal; the text itself is never stored. Null for templates. */
  goalSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .nullable(),
  hallId: z.string().nullable(),
  rank: memberRank.nullable(),
  /** The class routing used (never lower than the Hall's floor). */
  dataClass: dataClass.nullable(),
  /** What the classifier claimed, when it was asked, for auditing narrowing. */
  classifierClaim: z.object({ hallId: z.string(), rank: memberRank, dataClass }).nullable(),
  outcome: z.enum(['routed', 'blocked']),
  providerId: z.string().nullable(),
  profileId: z.string().nullable(),
  reason: z.enum(BLOCK_REASONS).nullable(),
})
/** A routing decision to log. */
export type RoutingEntry = z.infer<typeof routingEntry>

/** A logged decision with its per-guild sequence number. */
export interface LoggedRouting extends RoutingEntry {
  seq: number
}

/** A page of the routing log, newest first. */
export interface RoutingPage {
  entries: LoggedRouting[]
  /** Cursor for the next page (pass as `after`), or null. */
  next: number | null
}

/**
 * Port for the routing decision log. Insert-only; one row per `decisionKey` per guild, so a
 * retried handler logs once.
 */
export interface RoutingLog {
  /** Records a decision; a repeated `decisionKey` is a no-op. */
  record(guildId: string, entry: RoutingEntry): Promise<void>
  /** Decisions newest first, strictly below `after`, at most `limit` (capped at the maximum). */
  list(guildId: string, page: { after?: number; limit: number }): Promise<RoutingPage>
  /** The decisions with exactly these keys (at most {@link MAX_ROUTING_PAGE} are looked up). */
  forKeys(guildId: string, decisionKeys: readonly string[]): Promise<LoggedRouting[]>
}
