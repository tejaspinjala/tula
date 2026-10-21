/** The Council of Elders' five voices, in the order they speak. Data, never roster Members. */
export const COUNCIL_VOICES = ['architect', 'skeptic', 'security', 'ops', 'user'] as const
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
  /** `open` until its outcome is settled; `escalated` once it went to the Guild Master's Seal. */
  status: 'open' | 'escalated'
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
  /** The session's votes in voice order. */
  votes(guildId: string, sessionId: string): Promise<CouncilVote[]>
  /** Settles the session as escalated with a reason code; true the first time only. Appends `council.escalated`. */
  escalate(guildId: string, sessionId: string, reason: string): Promise<boolean>
}
