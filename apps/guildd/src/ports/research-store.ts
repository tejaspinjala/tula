/** One research call a Quest made (or is making): the slot it holds against the per-Quest cap. */
export interface ResearchCall {
  id: string
  hallId: string
  questId: string
  /** The Member who made the call. */
  memberId: string
}

/** What a Quest's research call records: ids and a hash of the query, never the query text. */
export interface NewResearchCall {
  hallId: string
  questId: string
  /** The attempt the call was made in. */
  attempt: number
  memberId: string
  /** Hex SHA-256 of the query: lets a ledger show repeats without storing what was asked. */
  queryHash: string
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
  /** Frees a slot whose call did not happen (refused charge, provider failure). Idempotent. */
  release(guildId: string, callId: string): Promise<void>
  /** The slots a Quest holds. */
  count(guildId: string, questId: string): Promise<number>
}
