/** One research call a Quest made (or is making): the slot it holds against the per-Quest cap. */
export interface ResearchCall {
  id: string
  hallId: string
  questId: string
  /** The Member who made the call. */
  memberId: string
}

/** What a Quest's research call records: ids only, never the query text. */
export interface NewResearchCall {
  hallId: string
  questId: string
  memberId: string
  /** The most calls the Quest may hold (all attempts); past it the call is refused. */
  maxPerQuest: number
  /** The instant the call happened. */
  at: Date
}

/** The outcome of a reservation: the slot taken, or `research_cap`. */
export type ReserveResult = { ok: true; call: ResearchCall } | { ok: false; error: 'research_cap' }

/**
 * Per-guild book of research calls, with every call scoped to one guild. It holds the per-Quest
 * cap: a slot is taken before any query leaves and the check and the take are one atomic step.
 */
export interface ResearchStore {
  /** Takes a slot for a call, or refuses with `research_cap` when the Quest already holds its cap. */
  reserve(guildId: string, input: NewResearchCall): Promise<ReserveResult>
  /** Frees a slot whose call never started (the charge was declined). Idempotent. A failed call keeps its slot. */
  release(guildId: string, callId: string): Promise<void>
  /** The slots a Quest holds. */
  count(guildId: string, questId: string): Promise<number>
  /** Records the Treasury spend a slot reserved, so a sweep can release it. Idempotent. */
  attachSpend(guildId: string, callId: string, spendId: string): Promise<void>
  /** Marks the call over (its spend settled or given back, or none was needed). Idempotent. */
  settle(guildId: string, callId: string): Promise<void>
  /**
   * Under the guild's sweep lock, frees every unsettled slot made before `before`, calling
   * `releaseSpend` for each one's reserved spend first. Returns how many slots it freed.
   * Idempotent: a freed slot is never visited again, and `releaseSpend` must itself be idempotent.
   */
  sweep(
    guildId: string,
    before: Date,
    releaseSpend: (spendId: string) => Promise<void>
  ): Promise<number>
}
