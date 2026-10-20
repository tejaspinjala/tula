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
  /** Marks the call over (its spend settled or given back, or none was needed). Idempotent. */
  settle(guildId: string, callId: string): Promise<void>
  /**
   * The ids of up to `limit` slots still unsettled and made before `before`, oldest first: calls a
   * crash may have left half done. A caller that finds another pass running gets an empty list
   * (the work is idempotent, so skipping is safe).
   */
  stale(guildId: string, before: Date, limit: number): Promise<string[]>
  /**
   * Ends a stale slot: `freed` also frees it from the cap, `settled` keeps it (the call had in
   * fact been charged). Idempotent.
   */
  close(guildId: string, callId: string, outcome: 'freed' | 'settled'): Promise<void>
}
