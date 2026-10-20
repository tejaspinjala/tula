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

/** Input to {@link SealStore.request}. The store derives the bound hash from `text` itself. */
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
  /**
   * The Quest's Seal round (1-based, default 1). A revision after a denial is a new round and a
   * new Seal row, even for the same text; a retry within one round is the same Seal.
   */
  round?: number
}

/** A Seal as read now; never carries a reservation token or its hash. */
export interface Seal extends NewSeal {
  id: string
  /** The Quest round this Seal belongs to. */
  round: number
  /** SHA-256 of `text`, computed by the store; the only payload this Seal can authorise. */
  actionHash: string
  status: SealStatus
  /** True for a `reserved` Seal whose reservation has lapsed: unresolved, not reusable. */
  stale: boolean
  requestedAt: string
  expiresAt: string
  decidedAt: string | null
  decisionNote: string | null
  /** Member id of the principal who approved or denied; null until decided. */
  decidedBy: string | null
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
  | 'bad_token'
  | 'not_stale'

/** Outcome of a Seal transition: the Seal after it, or why nothing changed. */
export type SealResult = { ok: true; seal: Seal } | { ok: false; reason: SealRefusal }

/** Outcome of {@link SealStore.reserve}: the holder's one-time token, shown only here. */
export type ReserveResult =
  | { ok: true; seal: Seal; token: string }
  | { ok: false; reason: SealRefusal }

/**
 * Port for Seals. Every transition is atomic (one winner among same-tick callers), appends its
 * event with ids and hashes only, and reads `requested` as `expired` once past its expiry and
 * `reserved` as stale once the reservation has lapsed. Authority is the engine's job.
 */
export interface SealStore {
  /** Requests a Seal. Idempotent per quest, round and hash: a retry returns the existing Seal. */
  request(guildId: string, input: NewSeal): Promise<Seal>
  /** The Seal of the Quest's latest round, or null when the Quest never asked. */
  forQuest(guildId: string, questId: string): Promise<Seal | null>
  /** The Seal, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<Seal | null>
  /**
   * Seals in id order strictly after `after`, optionally only those in `status` and, with
   * `decidedSince` (an ISO instant), only those decided at or after it (an indexed range, so a
   * pass over recent decisions never reads old ones).
   */
  list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus; decidedSince?: string }
  ): Promise<SealPage>
  /** Moves a requested Seal to approved or denied, once, bound to `expectedHash`. */
  decide(
    guildId: string,
    id: string,
    decision: {
      verdict: 'approved' | 'denied'
      expectedHash: string
      note?: string
      /** The deciding principal's member id; recorded in the audit event. */
      decidedBy?: string
    }
  ): Promise<SealResult>
  /**
   * Reserves an approved (or released) Seal for publishing `text`, which must hash to the sealed
   * hash. Returns a random token (stored only as a hash) that `consume` and `release` require.
   * A lapsed reservation is stale, not free: it cannot be reserved again.
   */
  reserve(guildId: string, id: string, text: string): Promise<ReserveResult>
  /** Consumes the reservation held by `token` for exactly `text`; works once, even when stale. */
  consume(guildId: string, id: string, use: { text: string; token: string }): Promise<SealResult>
  /** Gives the reservation held by `token` back unused. */
  release(guildId: string, id: string, use: { token: string }): Promise<SealResult>
  /** Guild Master only: releases a stale reservation (nothing was published) without its token. */
  releaseStale(guildId: string, id: string): Promise<SealResult>
  /**
   * Records `post.published_manually` for exactly `text` and consumes the Seal. Allowed from
   * approved, released, or a stale reservation (Guild Master resolution), never a live one. A stale reservation is
   * decided under the row lock: without `auth.reauthenticated` it is refused `not_authorised`.
   */
  markPosted(
    guildId: string,
    id: string,
    text: string,
    auth: { reauthenticated: boolean }
  ): Promise<SealResult>
  /**
   * Persists `expired` on up to 100 lapsed requested Seals (emitting `seal.expired`); returns how
   * many. With `approvedWindowMs`, an approved Seal never posted (decided at least that long ago)
   * expires too, so its Quest is not held for ever.
   */
  expireDue(guildId: string, opts?: { approvedWindowMs?: number }): Promise<number>
}
