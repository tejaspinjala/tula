import { z } from 'zod'

/** Largest page a {@link QuestQueue} list returns. */
export const MAX_QUEST_PAGE = 100

/** Attempts a Quest gets before it lands in the dead-letter list, unless the Quest says otherwise. */
export const DEFAULT_MAX_ATTEMPTS = 3

/** Longest wait before a failed Quest is retried. */
const MAX_RETRY_DELAY_MS = 300_000

/** Quest lifecycle: waiting, leased to its owner, held for a Seal, finished, or dead-lettered. */
export const questState = z.enum(['queued', 'active', 'awaiting_seal', 'done', 'dead'])
/** One Quest state. */
export type QuestState = z.infer<typeof questState>

/** How sensitive a Quest's data is; copied from its template. */
export const dataClass = z.enum(['public', 'internal', 'private'])
/** One data class. */
export type DataClass = z.infer<typeof dataClass>

/** A Member rank, copied from the template. */
export const questRank = z.enum(['apprentice', 'journeyman', 'adept'])

/** The fields a Quest is posted with. The job key de-duplicates retried posts. */
export const newQuest = z.object({
  jobKey: z.string().trim().min(1).max(200),
  /** Quests of one Campaign run one at a time, in posting order. */
  campaignId: z.string().trim().min(1).max(100).optional(),
  templateId: z.string().min(1).max(64),
  hallId: z.string().min(1).max(64),
  rank: questRank,
  dataClass,
  title: z.string().trim().min(1).max(200),
  /** The one Member that works the Quest. */
  ownerId: z.string().min(1).max(64),
  doneCondition: z.string().trim().min(1).max(2000),
  roundLimit: z.number().int().min(1).max(20),
  /** Quests that must be done before this one may start. */
  blockedBy: z.array(z.uuid()).max(50).default([]),
  maxAttempts: z.number().int().min(1).max(20).default(DEFAULT_MAX_ATTEMPTS),
})
/** Input to {@link QuestQueue.post}. */
export type NewQuest = z.input<typeof newQuest>

/** A Quest as the queue holds it. */
export interface Quest {
  id: string
  /** Posting order within the guild; strictly increasing. */
  seq: number
  jobKey: string
  campaignId: string | null
  templateId: string
  hallId: string
  rank: z.infer<typeof questRank>
  dataClass: DataClass
  title: string
  ownerId: string
  doneCondition: string
  state: QuestState
  /** Seal rounds used so far; capped by `roundLimit`. */
  round: number
  roundLimit: number
  blockedBy: string[]
  /** Deliveries so far; each claim, including a reclaim after a lease expired, is one. */
  attempts: number
  maxAttempts: number
  /** When the current lease ends; null unless `active`. */
  leaseExpiresAt: string | null
  /** The Quest is not delivered before this instant (retry backoff). */
  notBefore: string
  /** Coded reason of the last failure; never caller text. */
  lastError: FailReason | null
  createdAt: string
}

/** The only failure reasons a Quest records; free text from a worker is never stored or returned. */
export const FAIL_REASONS = [
  'timeout',
  'provider_error',
  'routing_blocked',
  'worker_crash',
  'sandbox_unavailable',
  'seal_rejected',
  'no_revision',
  'requester_reserved',
  'blocker_dead',
  'hall_locked',
  'hall_not_found',
  'private_provider_unavailable',
  'unknown',
] as const

/** See {@link FAIL_REASONS}. */
export type FailReason = (typeof FAIL_REASONS)[number]

/** Maps any caller-supplied value onto the allow-list; anything else becomes `unknown`. */
export function failReason(value: string): FailReason {
  return FAIL_REASONS.find((r) => r === value) ?? 'unknown'
}

/** Options of {@link QuestQueue.settleSeal}: the coded reason a rejection records (default `seal_rejected`). */
export interface SealSettleOptions {
  reason?: FailReason
}

/** How a Seal ended for the Quest that asked: consumed or posted, or denied or expired. */
export type SealOutcome = 'posted' | 'rejected'

/** Why a queue operation was refused. */
export type QuestErrorCode =
  | 'not_found'
  | 'already_claimed'
  | 'stale_lease'
  | 'invalid_state'
  | 'round_limit'
  | 'unknown_blocker'

/** Thrown by {@link QuestQueue} operations. */
export class QuestError extends Error {
  constructor(readonly code: QuestErrorCode) {
    super(code)
    this.name = 'QuestError'
  }
}

/** Event types a Quest transition appends. Payloads carry ids only. */
export type QuestEventType =
  | 'quest.posted'
  | 'quest.claimed'
  | 'quest.awaiting_seal'
  | 'quest.done'
  | 'quest.retry_scheduled'
  | 'quest.dead'

/** The result of a transition: the Quest after it, and the event to append (null for an idempotent no-op). */
export interface Transition {
  quest: Quest
  event: QuestEventType | null
}

/** Options for {@link QuestQueue.claim}. */
export interface ClaimOptions {
  /** How long the lease lasts before another claim may reclaim the Quest. */
  leaseMs: number
  /** The guild's concurrency cap: Quests with a live lease at once. */
  maxActive: number
  /** Claim this Quest only; `already_claimed` if it holds a live lease. */
  questId?: string
}

/** Paging for lists: `after` is the previous page's `next`. */
export interface QuestPaging {
  after?: string
  limit: number
  state?: QuestState
}

/** One page of Quests in posting order. */
export interface QuestPage {
  quests: Quest[]
  next: string | null
}

/**
 * Port for the Quest queue. Delivery is at-least-once: a Quest whose lease lapses is claimed
 * again, so handlers pass the `attempt` they were given and finishing is idempotent. State
 * lives in the adapter, never in process memory.
 */
export interface QuestQueue {
  /** Posts a Quest; a repeated job key returns the original with `created: false` and no new event. */
  post(guildId: string, input: NewQuest): Promise<{ quest: Quest; created: boolean }>
  /**
   * Leases the next deliverable Quest, or null. Deliverable: queued (or lease expired), past its
   * retry delay, every blocker done, first in its Campaign, and under the guild's concurrency cap.
   */
  claim(guildId: string, options: ClaimOptions): Promise<Quest | null>
  /** Extends the lease of the holder of `attempt`. */
  renew(guildId: string, id: string, attempt: number, leaseMs: number): Promise<Quest>
  /** Holds the Quest for a Seal. `round_limit` once the rounds are spent. Idempotent. */
  submitForSeal(guildId: string, id: string, attempt: number): Promise<Quest>
  /**
   * Settles a Quest held for a Seal, keyed by quest id (no lease needed): `posted` (the Seal was
   * consumed or posted) finishes it; `rejected` (denied or expired) sends it back to `queued` for
   * a revision round, or to `dead` once its rounds are spent (`round >= roundLimit`). Idempotent:
   * a Quest no longer `awaiting_seal` is returned unchanged. A Quest in any state but
   * `awaiting_seal`, `done`, `queued` or `dead` is `invalid_state`.
   */
  settleSeal(
    guildId: string,
    id: string,
    outcome: SealOutcome,
    opts?: SealSettleOptions
  ): Promise<Quest>
  /** Marks the Quest done. Idempotent: finishing a done Quest changes nothing. */
  complete(guildId: string, id: string, attempt: number): Promise<Quest>
  /** Records a failed attempt with a coded reason (see {@link FAIL_REASONS}; other text is stored as `unknown`): retried after a jittered delay, or dead-lettered when attempts are spent. Idempotent per attempt. */
  fail(guildId: string, id: string, attempt: number, error: string): Promise<Quest>
  /**
   * Releases the lease of every active Quest of the guild without spending an attempt: each goes
   * back to `queued`, deliverable at once, with `reason` as its last error. Atomic and idempotent;
   * returns how many it released. Used when the Gates are barred and the workers were killed.
   */
  releaseLeases(guildId: string, reason: FailReason): Promise<number>
  /**
   * {@link releaseLeases} for every guild at once, in one statement, so a global bar's cost does
   * not grow with the number of guilds. Idempotent; returns how many Quests it released.
   */
  releaseAllLeases(reason: FailReason): Promise<number>
  /**
   * Gives a claimed Quest back to `queued`, deliverable from `notBefore`, with the coded reason
   * `routing_blocked`. Fenced by `attempt` (`stale_lease` otherwise); `invalid_state` unless the
   * Quest is active. The delivery is not counted against `maxAttempts` by any failure path.
   * Idempotent: a repeat for the same delivery changes nothing.
   */
  releaseClaim(guildId: string, id: string, attempt: number, notBefore: Date): Promise<Quest>
  /**
   * Dead-letters a claimed Quest with a coded reason (see {@link FAIL_REASONS}), cascading to its
   * dependents (`blocker_dead`). Fenced by `attempt`; idempotent for the same delivery.
   */
  kill(guildId: string, id: string, attempt: number, reason: string): Promise<Quest>
  /** The Quest posted under `jobKey`, or null; never creates one. */
  findByJobKey(guildId: string, jobKey: string): Promise<Quest | null>
  /** One Quest, or null. */
  get(guildId: string, id: string): Promise<Quest | null>
  /** Quests in posting order, optionally of one state. */
  list(guildId: string, paging: QuestPaging): Promise<QuestPage>
  /** The dead-letter list: Quests that kept failing, in posting order. */
  deadLetters(guildId: string, paging: Omit<QuestPaging, 'state'>): Promise<QuestPage>
}

/** The delay before retry number `attempt` (1-based): exponential, capped, with jitter in [half, full]. */
export function retryDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** (attempt - 1))
  return Math.floor(ceiling / 2 + random * (ceiling / 2))
}

/** Whether the Quest holds a lease that has not lapsed at `now`. */
export function hasLiveLease(quest: Quest, now: Date): boolean {
  return (
    quest.state === 'active' &&
    quest.leaseExpiresAt !== null &&
    new Date(quest.leaseExpiresAt).getTime() > now.getTime()
  )
}

/** Throws unless the Quest is leased and `attempt` is the delivery it was given. */
function held(quest: Quest, attempt: number): void {
  if (quest.state !== 'active') {
    throw new QuestError('invalid_state')
  }
  if (quest.attempts !== attempt) {
    throw new QuestError('stale_lease')
  }
}

/** Leases the Quest to a new delivery. */
export function claimTransition(quest: Quest, now: Date, leaseMs: number): Transition {
  if (hasLiveLease(quest, now)) {
    throw new QuestError('already_claimed')
  }
  return {
    quest: {
      ...quest,
      state: 'active',
      attempts: quest.attempts + 1,
      leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString(),
    },
    event: 'quest.claimed',
  }
}

/** Extends the lease of the delivery `attempt`. */
export function renewTransition(
  quest: Quest,
  attempt: number,
  now: Date,
  leaseMs: number
): Transition {
  held(quest, attempt)
  return {
    quest: { ...quest, leaseExpiresAt: new Date(now.getTime() + leaseMs).toISOString() },
    event: null,
  }
}

/** Moves an active Quest to `awaiting_seal`, spending a round. A repeat for the same delivery is a no-op. */
export function submitTransition(quest: Quest, attempt: number): Transition {
  if (quest.state === 'awaiting_seal' && quest.attempts === attempt) {
    return { quest, event: null }
  }
  held(quest, attempt)
  if (quest.round >= quest.roundLimit) {
    throw new QuestError('round_limit')
  }
  return {
    quest: { ...quest, state: 'awaiting_seal', round: quest.round + 1, leaseExpiresAt: null },
    event: 'quest.awaiting_seal',
  }
}

/**
 * Finishes a Quest. Finishing a done Quest is a no-op, so a handler that runs twice has one effect.
 * From `awaiting_seal` only the delivery that submitted may finish it (else `stale_lease`); only
 * the Seal-approval path calls it in that state.
 */
export function completeTransition(quest: Quest, attempt: number): Transition {
  if (quest.state === 'done') {
    return { quest, event: null }
  }
  if (quest.state === 'awaiting_seal') {
    if (quest.attempts !== attempt) {
      throw new QuestError('stale_lease')
    }
  } else {
    held(quest, attempt)
  }
  return { quest: { ...quest, state: 'done', leaseExpiresAt: null }, event: 'quest.done' }
}

/** Whether a lease has lapsed with every attempt spent: such a Quest is dead-lettered, never leased again. */
export function isExhausted(quest: Quest, now: Date): boolean {
  return (
    quest.state === 'active' && !hasLiveLease(quest, now) && quest.attempts >= quest.maxAttempts
  )
}

/** Dead-letters a Quest whose lease lapsed with its attempts spent. */
export function expireTransition(quest: Quest): Transition {
  return {
    quest: { ...quest, state: 'dead', leaseExpiresAt: null, lastError: 'timeout' },
    event: 'quest.dead',
  }
}

/** Records a failed delivery: retry after `delayMs`, or dead-letter when attempts are spent. */
export function failTransition(
  quest: Quest,
  attempt: number,
  error: string,
  now: Date,
  delayMs: number
): Transition {
  if ((quest.state === 'queued' || quest.state === 'dead') && quest.attempts === attempt) {
    return { quest, event: null }
  }
  held(quest, attempt)
  const lastError = failReason(error)
  if (quest.attempts >= quest.maxAttempts) {
    return {
      quest: { ...quest, state: 'dead', leaseExpiresAt: null, lastError },
      event: 'quest.dead',
    }
  }
  return {
    quest: {
      ...quest,
      state: 'queued',
      leaseExpiresAt: null,
      lastError,
      notBefore: new Date(now.getTime() + delayMs).toISOString(),
    },
    event: 'quest.retry_scheduled',
  }
}

/** Gives a claimed Quest back to `queued` until `notBefore`; a repeat for the same delivery is a no-op. */
export function releaseClaimTransition(quest: Quest, attempt: number, notBefore: Date): Transition {
  if (quest.state === 'queued' && quest.attempts === attempt && attempt > 0) {
    return { quest, event: null }
  }
  held(quest, attempt)
  return {
    quest: {
      ...quest,
      state: 'queued',
      leaseExpiresAt: null,
      lastError: 'routing_blocked',
      notBefore: notBefore.toISOString(),
    },
    event: 'quest.retry_scheduled',
  }
}

/** Dead-letters a claimed Quest with a coded reason; a repeat for the same delivery is a no-op. */
export function killTransition(quest: Quest, attempt: number, reason: string): Transition {
  if (quest.state === 'dead' && quest.attempts === attempt) {
    return { quest, event: null }
  }
  held(quest, attempt)
  return {
    quest: { ...quest, state: 'dead', leaseExpiresAt: null, lastError: failReason(reason) },
    event: 'quest.dead',
  }
}

/**
 * Settles a Quest held for a Seal. `posted` finishes it; `rejected` queues a revision round, or
 * dead-letters it when `round >= roundLimit`. Anything not `awaiting_seal` is returned unchanged
 * when it already left that state by this route (done, queued, dead), else `invalid_state`.
 */
export function sealSettleTransition(
  quest: Quest,
  outcome: SealOutcome,
  now: Date,
  opts: SealSettleOptions = {}
): Transition {
  const reason = opts.reason ?? 'seal_rejected'
  if (quest.state !== 'awaiting_seal') {
    if (quest.state === 'active') {
      throw new QuestError('invalid_state')
    }
    return { quest, event: null }
  }
  if (outcome === 'posted') {
    return { quest: { ...quest, state: 'done', leaseExpiresAt: null }, event: 'quest.done' }
  }
  if (quest.round >= quest.roundLimit) {
    return {
      quest: { ...quest, state: 'dead', leaseExpiresAt: null, lastError: reason },
      event: 'quest.dead',
    }
  }
  return {
    quest: {
      ...quest,
      state: 'queued',
      leaseExpiresAt: null,
      lastError: reason,
      notBefore: now.toISOString(),
    },
    event: 'quest.retry_scheduled',
  }
}

/**
 * The Quests a dead Quest takes with it: every in-flight Quest (queued, active or awaiting a Seal)
 * that is blocked by it directly or through another such Quest, each dead-lettered with the coded
 * reason `blocker_dead`, in posting order. Without this they would wait on a blocker that can
 * never be done. Pure and shared by both adapters; a dependent already finished is untouched.
 */
export function cascadeDeadTransitions(quests: readonly Quest[], deadId: string): Transition[] {
  const gone = new Set([deadId])
  const out: Transition[] = []
  for (const q of [...quests].sort((a, b) => a.seq - b.seq)) {
    if (IN_FLIGHT.includes(q.state) && !gone.has(q.id) && q.blockedBy.some((id) => gone.has(id))) {
      gone.add(q.id)
      out.push({
        quest: { ...q, state: 'dead', leaseExpiresAt: null, lastError: 'blocker_dead' },
        event: 'quest.dead',
      })
    }
  }
  return out
}

const IN_FLIGHT: readonly QuestState[] = ['queued', 'active', 'awaiting_seal']

/**
 * Picks the Quest `claim` should lease from `quests` (every Quest of one guild), or null.
 * Pure: used by the memory adapter; the Postgres adapter expresses the same rules in SQL.
 * Rules: under the concurrency cap; queued, or active with a lapsed lease; past `notBefore`;
 * every blocker done; and no earlier in-flight Quest in the same Campaign.
 */
export function pickClaimable(
  quests: readonly Quest[],
  now: Date,
  options: ClaimOptions,
  hallPaused: (hallId: string) => boolean = () => false
): Quest | null {
  if (quests.filter((q) => hasLiveLease(q, now)).length >= options.maxActive) {
    return null
  }
  const doneIds = new Set(quests.filter((q) => q.state === 'done').map((q) => q.id))
  const eligible = (q: Quest): boolean =>
    !hallPaused(q.hallId) &&
    (q.state === 'queued' || (q.state === 'active' && !hasLiveLease(q, now))) &&
    new Date(q.notBefore).getTime() <= now.getTime() &&
    q.blockedBy.every((id) => doneIds.has(id)) &&
    (q.campaignId === null ||
      !quests.some(
        (o) => o.campaignId === q.campaignId && o.seq < q.seq && IN_FLIGHT.includes(o.state)
      ))
  const ordered = [...quests].sort((a, b) => a.seq - b.seq)
  return (
    ordered.find(
      (q) => (options.questId === undefined || q.id === options.questId) && eligible(q)
    ) ?? null
  )
}
