import type { TreasuryLimits } from '../guild-config'

/** Largest page a {@link TreasuryStore} list call returns. */
export const MAX_TREASURY_PAGE = 100
/** The Treasury a new guild is funded with, in cents ($100 of paper). */
export const STARTING_FUNDS_CENTS = 10_000

/** The buckets of money: `operating` is what spends draw on, `reserve` is released only by the Guild Master. */
export const BUCKETS = ['operating', 'reserve', 'profit'] as const
/** One bucket of the Treasury. */
export type Bucket = (typeof BUCKETS)[number]

/** Balances per bucket, in integer cents. */
export type Balances = Record<Bucket, number>

/** What a ledger entry records. Every entry is a signed delta on one bucket. */
export const ENTRY_KINDS = [
  'seed',
  'revenue',
  'reserve_release',
  'spend_reserve',
  'spend_settle',
  'spend_release',
] as const
/** One kind of ledger entry. */
export type EntryKind = (typeof ENTRY_KINDS)[number]

/**
 * One append-only ledger entry (`mode: paper`: no payment provider is ever called). `hash`
 * covers the entry and `prevHash`, so altering any entry breaks the chain from there on.
 */
export interface LedgerEntry {
  /** Per-guild sequence number, gap-free from 1. */
  seq: number
  id: string
  kind: EntryKind
  bucket: Bucket
  /** Signed integer cents; the sum per bucket is that bucket's balance. */
  amountCents: number
  mode: 'paper'
  spendId: string | null
  /** The caller's idempotency key (`seed`, `revenue:<key>`, `reserve:<key>`), or null. */
  idemKey: string | null
  /** The evidence a revenue entry rests on; null for every other kind. */
  evidence: string | null
  /** The UTC day the entry belongs to (`YYYY-MM-DD`). */
  day: string
  createdAt: string
  prevHash: string
  hash: string
}

/** Spend request states. */
export const SPEND_STATUSES = [
  'pending_approval',
  'reserved',
  'settled',
  'released',
  'denied',
] as const
/** One state of a spend request. */
export type SpendStatus = (typeof SPEND_STATUSES)[number]

/** Why a spend needs the Guild Master instead of the Treasurer. */
export type SpendEscalation = 'over_treasurer_limit' | 'daily_cap'

/** A spend request against the operating envelope. Funds are held while `reserved`. */
export interface Spend {
  id: string
  /** Per-guild sequence number; the paging cursor. */
  seq: number
  key: string
  amountCents: number
  /** What was actually spent, once settled. */
  settledCents: number | null
  purpose: string
  requestedBy: string
  status: SpendStatus
  /** Set while `pending_approval`: which rule sent the request to the Guild Master. */
  escalation: SpendEscalation | null
  approvedBy: 'treasurer' | 'guild_master' | null
  createdAt: string
}

/** A spend request to check. */
export interface NewSpend {
  /** Idempotency key: a retried request with the same key is the same request. */
  key: string
  amountCents: number
  purpose: string
  requestedBy: string
}

/** Revenue to record; `evidence` is required. */
export interface NewRevenue {
  key: string
  amountCents: number
  evidence: string
}

/** The Treasury at a glance. */
export interface TreasurySnapshot {
  mode: 'paper'
  balances: Balances
  /** Net paper spent so far today (UTC), reservations included. */
  spentTodayCents: number
  day: string
}

/** Why a Treasury operation was refused. */
export type TreasuryRefusal =
  | 'invalid_amount'
  | 'evidence_required'
  | 'insufficient_funds'
  | 'not_found'
  | 'wrong_state'
  | 'exceeds_reserved'

/** Result of an operation that changes one spend request. */
export type SpendResult =
  | { ok: true; spend: Spend; created: boolean }
  | { ok: false; reason: TreasuryRefusal }

/** Result of an operation that appends ledger entries. */
export type EntriesResult =
  | { ok: true; entries: LedgerEntry[]; created: boolean }
  | { ok: false; reason: TreasuryRefusal }

/** A page of newest-last items. */
export interface TreasuryPage<T> {
  items: T[]
  /** Cursor for the next page (pass as `after`), or null. */
  next: number | null
}

/** Result of walking the hash chain. */
export type LedgerVerdict =
  | { intact: true; entries: number }
  | { intact: false; firstBadSeq: number; reason: string }

/**
 * Port for the paper Treasury. Every write is atomic per guild: the check against the balances
 * and limits and the ledger append happen as one step, so two concurrent requests can never
 * overspend an envelope. Limits come from guild config and are passed in; the rules are code,
 * never a model decision. Only deterministic code calls this port; no agent-facing tool may.
 */
export interface TreasuryStore {
  /** Balances and today's net spend. Funds a new guild's Treasury on first use. */
  snapshot(guildId: string, limits: TreasuryLimits): Promise<TreasurySnapshot>
  /** Records revenue: `reinvestPercent` goes to operating, the rest to profit. Evidence is required. */
  recordRevenue(guildId: string, input: NewRevenue, limits: TreasuryLimits): Promise<EntriesResult>
  /** Guild Master only: moves cents from the reserve to the operating envelope. */
  releaseReserve(
    guildId: string,
    input: { key: string; amountCents: number },
    limits: TreasuryLimits
  ): Promise<EntriesResult>
  /**
   * Checks a spend deterministically. Within the Treasurer limit and the daily cap, and funded,
   * the cents are reserved at once; otherwise the request waits for the Guild Master.
   */
  requestSpend(guildId: string, input: NewSpend, limits: TreasuryLimits): Promise<SpendResult>
  /** Guild Master only: approves a request that was waiting, reserving its cents if still funded. */
  approveSpend(guildId: string, spendId: string): Promise<SpendResult>
  /** Denies a request that was waiting. */
  denySpend(guildId: string, spendId: string): Promise<SpendResult>
  /** Settles a reserved spend at what was actually spent (at most the reservation). */
  settleSpend(guildId: string, spendId: string, actualCents: number): Promise<SpendResult>
  /** Releases a reserved spend: nothing was spent. */
  releaseSpend(guildId: string, spendId: string): Promise<SpendResult>
  /** One spend request, or null. */
  getSpend(guildId: string, spendId: string): Promise<Spend | null>
  /** Spend requests, oldest first, after the `after` cursor. */
  listSpends(guildId: string, page: { after?: number; limit: number }): Promise<TreasuryPage<Spend>>
  /** Ledger entries, oldest first, after the `after` seq. */
  listEntries(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<TreasuryPage<LedgerEntry>>
  /** Replays the hash chain; names the first bad entry if any was altered, removed or reordered. */
  verifyLedger(guildId: string): Promise<LedgerVerdict>
}
