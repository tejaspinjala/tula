import { z } from 'zod'

/** Largest page a {@link ModelLedger.report} call returns. */
export const MAX_USAGE_PAGE = 100

/** What a usage report groups by. */
export const USAGE_GROUPS = ['run', 'quest', 'hall', 'day'] as const
/** One usage grouping. */
export type UsageGroup = (typeof USAGE_GROUPS)[number]
/** Validates a grouping from a query string. */
export const usageGroup = z.enum(USAGE_GROUPS)

/** Whether `value` is a real calendar day as `YYYY-MM-DD` (the cursor of a by-day report). */
export function isUsageDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false
  }
  const parsed = new Date(`${value}T00:00:00.000Z`)
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}

/** A run's lifecycle: waiting for cap room, holding a live token, or revoked. */
export type RunState = 'queued' | 'active' | 'revoked'

/** Why a run was revoked: its Hall paused (reissuable on resume) or an explicit, final revoke. */
export type RevokeReason = 'hall_paused' | 'manual'

/** A run as the ledger holds it. The token itself is never stored, only its hash. */
export interface RunRecord {
  runId: string
  questId: string
  /** The Quest attempt (delivery) this run belongs to. */
  attempt: number
  hallId: string
  providerId: string
  profileId: string
  state: RunState
  /** Why a revoked run was revoked; null unless revoked (or revoked before reasons existed). */
  revokeReason: RevokeReason | null
  /** When the live token stops working; null while queued. */
  expiresAt: string | null
}

/** A run to open. `tokenHash` and `expiresAt` are present exactly when `state` is `active`. */
export interface NewRun {
  runId: string
  questId: string
  attempt: number
  hallId: string
  providerId: string
  profileId: string
  state: 'queued' | 'active'
  tokenHash: string | null
  expiresAt: string | null
}

/** One call's usage. `costMicros` is null for providers that bill no dollars (subscription). */
export interface UsageEntry {
  /** Server-minted id of the call; a caller never chooses it. */
  callKey: string
  runId: string
  /** UTC day `YYYY-MM-DD` the call is attributed to. */
  day: string
  inputTokens: number
  outputTokens: number
  costMicros: number | null
}

/** A call's reservation: its estimated charge, checked against the daily caps before the provider is called. */
export interface Reservation extends UsageEntry {
  /** The caller's own idempotency key, scoped to the run; a reuse is `duplicate`. Null for none. */
  clientKey: string | null
  /** Daily caps the estimate must fit under, with everything already charged that day. */
  caps: { tokens: number; costMicros: number }
}

/** The outcome of {@link ModelLedger.reserve}. */
export type ReserveResult =
  | { status: 'reserved' }
  | { status: 'duplicate' }
  | { status: 'cap_reached'; reason: 'daily_tokens' | 'daily_spend' }

/** Tokens and dollars (millionths) spent. */
export interface Totals {
  tokens: number
  costMicros: number
}

/** One row of the cost table: spend for one run, Quest, Hall or day. */
export interface UsageRow {
  key: string
  calls: number
  inputTokens: number
  outputTokens: number
  costMicros: number
}

/** A page of the cost table, ascending by key. */
export interface UsagePage {
  rows: UsageRow[]
  /** Cursor for the next page (pass as `after`), or null. */
  next: string | null
}

/**
 * Port for the model gateway's ledger: per-run token records (hashes only), the metering of every
 * call per run, Quest, Hall and guild-day, and the once-a-day cap notice. Every method is scoped
 * to one guild.
 */
export interface ModelLedger {
  /** Opens a run; a repeated `runId` is a no-op that reports `exists`. */
  openRun(guildId: string, run: NewRun): Promise<'created' | 'exists'>
  /**
   * Moves a queued run, or one revoked by a Hall pause, to active with a fresh token; false for
   * an active run, a manually revoked run, or an unknown one.
   */
  activate(guildId: string, runId: string, tokenHash: string, expiresAt: string): Promise<boolean>
  /** The run holding the token with this hash, or null. */
  findByTokenHash(guildId: string, tokenHash: string): Promise<RunRecord | null>
  /** One run, or null. */
  getRun(guildId: string, runId: string): Promise<RunRecord | null>
  /** Revokes the run's token for good (`manual`); false if the run is unknown. */
  revoke(guildId: string, runId: string): Promise<boolean>
  /** Revokes every queued or active run of the Hall (`hall_paused`); returns how many. */
  revokeHallRuns(guildId: string, hallId: string): Promise<number>
  /**
   * Revokes every queued, active or Hall-paused run of the guild for good (`manual`, so none is
   * ever reissued; Bar the Gates); returns how many runs changed.
   */
  revokeGuildRuns(guildId: string): Promise<number>
  /** Queued runs, oldest first, at most `limit`. */
  listQueued(guildId: string, limit: number): Promise<RunRecord[]>
  /**
   * Atomically, per guild: charges the call's estimate only if the day's charges (settled and
   * pending) plus the estimate stay within `caps`; otherwise changes nothing. A reused
   * `clientKey` for the same run is `duplicate`. Rejects for an unknown run.
   */
  reserve(guildId: string, reservation: Reservation): Promise<ReserveResult>
  /**
   * Replaces a reservation's estimate with the actual usage. A reservation never settled keeps
   * its estimate as the charge.
   */
  settle(
    guildId: string,
    callKey: string,
    actual: { inputTokens: number; outputTokens: number; costMicros: number | null }
  ): Promise<void>
  /** Totals for one guild-day. */
  dayTotals(guildId: string, day: string): Promise<Totals>
  /** The cost table grouped by `by`, ascending by key, strictly after `after`, at most `limit`. */
  report(
    guildId: string,
    by: UsageGroup,
    page: { after?: string; limit: number }
  ): Promise<UsagePage>
  /**
   * Records that the Steward told the Guild Master the cap was hit on `day`, emitting the event
   * `steward.cap_reached` with it. True only for the first call of that guild-day.
   */
  noteCapReached(guildId: string, day: string, reason: string): Promise<boolean>
}
