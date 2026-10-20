import { z } from 'zod'

/** Largest page a {@link SealStore.list} call returns. */
export const MAX_SEAL_PAGE = 100
/** How long a requested Seal waits for the Guild Master before it expires (72 hours). */
export const SEAL_TTL_MS = 72 * 60 * 60 * 1000
/** How long a reservation holds an approved Seal before it reads as approved again (10 minutes). */
export const SEAL_RESERVATION_MS = 10 * 60 * 1000

/** Seal states: requested, then approved | denied | expired; approved, then reserved, then consumed | released. */
export const SEAL_STATUSES = [
  'requested',
  'approved',
  'denied',
  'expired',
  'reserved',
  'consumed',
  'released',
] as const
/** One state of a Seal. */
export type SealStatus = (typeof SEAL_STATUSES)[number]

/** The hash a Seal is bound to: lower-case hex SHA-256 of the exact Proposal text. */
export const actionHash = z.string().regex(/^[0-9a-f]{64}$/)

/** Hashes a Proposal's exact text; the Seal binds to this value and to no other payload. */
export async function hashProposal(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Input to {@link SealStore.request}. */
export interface NewSeal {
  questId: string
  /** The agent or member asking; it can never decide its own request. */
  requestedBy: string
  /** What is being sent outside the guild, e.g. `post`. */
  kind: string
  /** The exact Proposal text the Guild Master reads. */
  text: string
  /** The evidence shown beside the text. */
  evidence: string
  /** Hash of `text`; the engine computes it, the store only binds it. */
  actionHash: string
}

/** A Seal as stored, with `status` already read at the store's current time. */
export interface Seal extends NewSeal {
  id: string
  status: SealStatus
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
  decisionNote: string | null
  reservedUntil: string | null
  consumedAt: string | null
}

/** One page of Seals in id order; `next` is the cursor for the following page, null at the end. */
export interface SealPage {
  seals: Seal[]
  next: string | null
}

/** Why a Seal operation changed nothing. */
export type SealRefusal =
  | 'not_found'
  | 'hash_mismatch'
  | 'not_requested'
  | 'expired'
  | 'not_approved'
  | 'not_reserved'
  | 'not_authorised'

/** Outcome of a Seal transition: the Seal after it, or why nothing changed. */
export type SealResult = { ok: true; seal: Seal } | { ok: false; reason: SealRefusal }

/**
 * Port for Seals. Every transition is atomic (one winner among same-tick callers), appends its
 * event with ids and hashes only, and reads `requested` as `expired` once past its expiry and
 * `reserved` as `approved` once the reservation has lapsed. Authority is the engine's job.
 */
export interface SealStore {
  /** Requests a Seal. Idempotent per quest and hash: a retry returns the existing Seal. */
  request(guildId: string, input: NewSeal): Promise<Seal>
  /** The Seal, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<Seal | null>
  /** Seals in id order strictly after `after`, optionally only those in `status`. */
  list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus }
  ): Promise<SealPage>
  /** Moves a requested Seal to approved or denied, once, bound to `expectedHash`. */
  decide(
    guildId: string,
    id: string,
    decision: { verdict: 'approved' | 'denied'; expectedHash: string; note?: string }
  ): Promise<SealResult>
  /** Reserves an approved (or released, or lapsed-reserved) Seal for one action with this hash. */
  reserve(guildId: string, id: string, hash: string): Promise<SealResult>
  /** Consumes a live reservation for this hash; a Seal can be consumed once. */
  consume(guildId: string, id: string, hash: string): Promise<SealResult>
  /** Gives a live reservation back without using it. */
  release(guildId: string, id: string, hash: string): Promise<SealResult>
  /** Records `post.published_manually` and consumes the Seal; the Quest completes on that event. */
  markPosted(guildId: string, id: string, hash: string): Promise<SealResult>
  /** Persists `expired` on every lapsed requested Seal (emitting `seal.expired`); returns how many. */
  expireDue(guildId: string): Promise<number>
}
