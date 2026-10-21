/** The Council of Elders' five voices, in the order they speak. Data, never roster Members. */
export const COUNCIL_VOICES = ['architect', 'skeptic', 'security', 'ops', 'user'] as const
/** The most sessions one list page returns. */
export const MAX_COUNCIL_PAGE = 50

/** One voice of the Council. */
export type CouncilVoice = (typeof COUNCIL_VOICES)[number]

/** What a voice votes. */
export type VoteChoice = 'approve' | 'block' | 'abstain'

/** Why the system, not the voice, abstained: unusable output, a failed or timed-out run, or a reached cap. */
export type AbstainCode = 'invalid_output' | 'failed' | 'cap_reached'

/** One Council session: held once per (guild, Proposal hash). */
export interface CouncilSession {
  id: string
  questId: string
  /** SHA-256 of the exact Proposal text the voices judged. */
  proposalHash: string
  /** UTC day `YYYY-MM-DD` the session was convened; counts against the daily sessions cap. */
  day: string
  /**
   * `open` until its outcome is settled; `escalated` once it went to the Guild Master's Seal;
   * `approved` once a Quest consumed an approval on it (see {@link CouncilStore.approve}).
   */
  status: 'open' | 'escalated' | 'approved'
  /** Code of why it escalated; null while open. */
  reason: string | null
  createdAt: string
}

/** One voice's vote, as stored: insert-only, one per (session, voice). */
export interface CouncilVote {
  sessionId: string
  voice: CouncilVoice
  vote: VoteChoice
  /** The voice's reasons; untrusted model text, bounded, shown only as Seal evidence. */
  reasons: string[]
  /** Set when the vote is a system abstention rather than the voice's own; null otherwise. */
  abstainCode: AbstainCode | null
  inputTokens: number
  outputTokens: number
  /** Cost in millionths of a dollar; null for a provider that bills no dollars or a run that never started. */
  costMicros: number | null
}

/** A vote to record; the session id is given separately. */
export type NewCouncilVote = Omit<CouncilVote, 'sessionId'>

/** The outcome of {@link CouncilStore.open}. */
export type OpenSessionResult =
  | { status: 'created'; session: CouncilSession }
  | { status: 'existing'; session: CouncilSession }
  | { status: 'cap_reached' }

/** The outcome of {@link CouncilStore.approve}. */
export type ApproveResult = 'approved' | 'cap_reached' | 'not_found'

/**
 * Port for the Council of Elders' sessions and votes. Every method is scoped to one guild. A
 * session is created before any voice runs, so a restart finds it and resumes; votes are
 * insert-only, so a finished voice is never re-run or rewritten.
 */
export interface CouncilStore {
  /**
   * Opens the session for (guild, Proposal hash), or returns the one that exists (even when
   * `sessionCap` is reached, so a resume is never refused). A new session is refused as
   * `cap_reached` when `sessionCap` sessions were already convened on `day`. Convening appends
   * `council.convened` once.
   */
  open(
    guildId: string,
    input: { questId: string; proposalHash: string; day: string; sessionCap: number }
  ): Promise<OpenSessionResult>
  /**
   * Records a voice's vote; false (and nothing changes) when that voice already voted in the
   * session or the session is not this guild's. Appends `council.voted` (never the reasons).
   */
  recordVote(guildId: string, sessionId: string, vote: NewCouncilVote): Promise<boolean>
  /**
   * One page of the guild's sessions, newest first. `after` is the id of the last session of the
   * previous page; `next` is that id when older sessions remain, else null. An unknown `after`
   * (or another guild's) yields an empty page.
   */
  list(
    guildId: string,
    page: { limit: number; after?: string }
  ): Promise<{ sessions: CouncilSession[]; next: string | null }>
  /** The session's votes in voice order. */
  votes(guildId: string, sessionId: string): Promise<CouncilVote[]>
  /**
   * Claims an open session for `owner` (a random id per worker run) to run its voices: true when
   * no live claim exists (none, or one that ended at or before `now`) or when `owner` already
   * holds it (a renewal), setting a claim that ends `ttlMs` after `now`. Atomic, so two workers
   * never both run the voices. False for another owner's live claim, an escalated session or
   * another guild's id. No transaction is held across the model calls: the claim is the lock.
   */
  claim(
    guildId: string,
    sessionId: string,
    owner: string,
    now: Date,
    ttlMs: number
  ): Promise<boolean>
  /**
   * Gives `owner`'s claim up (the voices were halted). Clears nothing when someone else holds the
   * claim now, so a stale release never frees a live one.
   */
  release(guildId: string, sessionId: string, owner: string): Promise<void>
  /**
   * Counts one failed convene attempt (a halt other than Bar the Gates) and returns the new
   * count; 0 for an unknown session or another guild's id.
   */
  recordFailure(guildId: string, sessionId: string): Promise<number>
  /** Settles the session as escalated; it also clears any claim. with a reason code; true the first time only. Appends `council.escalated`. */
  escalate(guildId: string, sessionId: string, reason: string): Promise<boolean>
  /**
   * Council approvals given on `day` to Quests other than `excludingQuestId`: the Quest's own
   * earlier approval is never counted against it, so a retry after a crash is not refused.
   */
  approvalsToday(guildId: string, day: string, excludingQuestId: string): Promise<number>
  /**
   * Gives `questId` its own approval on the session, atomically against `cap` approvals per `day`
   * (counted per Quest, never per session: two Quests with the same Proposal hash share a session
   * but each consume one approval). Idempotent per (session, Quest): a retry returns `approved`
   * without consuming another. `cap_reached` changes nothing. The first approval settles an open
   * session as `approved` and clears its claim. Appends `council.approved` once per Quest.
   */
  approve(
    guildId: string,
    sessionId: string,
    input: { questId: string; day: string; cap: number }
  ): Promise<ApproveResult>
  /**
   * Appends `council.halted` (Bar the Gates stopped the session; the Quest stays Awaiting Seal),
   * once per (session, Quest): true the first time, false for every repeat (nothing appended), so
   * passes that keep finding the guild barred never grow the audit chain.
   */
  halt(guildId: string, sessionId: string, questId: string): Promise<boolean>
  /**
   * The id of the session that gave `questId` an approval on the Proposal with `proposalHash`, or
   * null when it has none. Lets a crashed settlement find and finish its own approval.
   */
  approvalFor(guildId: string, questId: string, proposalHash: string): Promise<string | null>
}
