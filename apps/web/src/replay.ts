/** One entry of the guild's event log, as the history route returns it. */
export interface ReplayEvent {
  seq: number
  type: string
  payload: unknown
  occurredAt: string
}

/** Where a replay stops: after a seq, after an instant (ISO), or at the end of the log. */
export type ReplayPoint = { seq: number } | { time: string } | null

/** The state of the ledger view implied by the log up to a point. */
export interface ReplayState {
  appliedSeq: number
  quests: Record<'queued' | 'active' | 'awaiting_seal' | 'done' | 'dead', string[]>
  seals: Record<
    'requested' | 'approved' | 'denied' | 'reserved' | 'consumed' | 'released' | 'expired',
    string[]
  >
  pausedHalls: string[]
  balances: { operating: number; reserve: number; profit: number }
  notes: number
}

/** Stub: not implemented yet. */
export function replayTo(_events: readonly ReplayEvent[], _point: ReplayPoint): ReplayState {
  return {
    appliedSeq: 0,
    quests: { queued: [], active: [], awaiting_seal: [], done: [], dead: [] },
    seals: {
      requested: [],
      approved: [],
      denied: [],
      reserved: [],
      consumed: [],
      released: [],
      expired: [],
    },
    pausedHalls: [],
    balances: { operating: 0, reserve: 0, profit: 0 },
    notes: 0,
  }
}
