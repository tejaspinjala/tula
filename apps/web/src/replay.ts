import { z } from 'zod'

/** One entry of the guild's event log, as the history route returns it. */
export interface ReplayEvent {
  seq: number
  type: string
  payload: unknown
  occurredAt: string
}

/** Where a replay stops: after a seq, after an instant (ISO), or at the end of the log. */
export type ReplayPoint = { seq: number } | { time: string } | null

/** The Quest states the board shows. */
export type ReplayQuestState = 'queued' | 'active' | 'awaiting_seal' | 'done' | 'dead'
/** The Seal statuses the ledger shows. */
export type ReplaySealStatus =
  | 'requested'
  | 'approved'
  | 'denied'
  | 'reserved'
  | 'consumed'
  | 'released'
  | 'expired'

/** The state of the ledger view implied by the log up to a point. */
export interface ReplayState {
  /** Highest seq applied; 0 when none. */
  appliedSeq: number
  quests: Record<ReplayQuestState, string[]>
  seals: Record<ReplaySealStatus, string[]>
  pausedHalls: string[]
  balances: { operating: number; reserve: number; profit: number }
  notes: number
}

const QUEST_EVENT: Record<string, ReplayQuestState> = {
  'quest.posted': 'queued',
  'quest.claimed': 'active',
  'quest.awaiting_seal': 'awaiting_seal',
  'quest.done': 'done',
  'quest.retry_scheduled': 'queued',
  'quest.dead': 'dead',
}
const SEAL_EVENT: Record<string, ReplaySealStatus> = {
  'seal.requested': 'requested',
  'seal.approved': 'approved',
  'seal.denied': 'denied',
  'seal.reserved': 'reserved',
  'seal.consumed': 'consumed',
  'seal.released': 'released',
  'seal.expired': 'expired',
}

const questPayload = z.object({ questId: z.string() })
const sealPayload = z.object({ sealId: z.string() })
const hallPayload = z.object({ hallId: z.string() })
const entryPayload = z.object({
  bucket: z.enum(['operating', 'reserve', 'profit']),
  amountCents: z.number(),
})

function emptyState(): ReplayState {
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

function moveTo<K extends string>(lists: Record<K, string[]>, id: string, to: K): void {
  for (const list of Object.values<string[]>(lists)) {
    const at = list.indexOf(id)
    if (at >= 0) {
      list.splice(at, 1)
    }
  }
  lists[to].push(id)
}

function apply(state: ReplayState, event: ReplayEvent): void {
  state.appliedSeq = event.seq
  const quest = QUEST_EVENT[event.type]
  if (quest) {
    const p = questPayload.safeParse(event.payload)
    if (p.success) {
      moveTo(state.quests, p.data.questId, quest)
    }
    return
  }
  const seal = SEAL_EVENT[event.type]
  if (seal) {
    const p = sealPayload.safeParse(event.payload)
    if (p.success) {
      moveTo(state.seals, p.data.sealId, seal)
    }
    return
  }
  if (event.type === 'hall.paused' || event.type === 'hall.resumed') {
    const p = hallPayload.safeParse(event.payload)
    if (p.success) {
      const rest = state.pausedHalls.filter((h) => h !== p.data.hallId)
      state.pausedHalls = event.type === 'hall.paused' ? [...rest, p.data.hallId] : rest
    }
    return
  }
  if (event.type === 'treasury.entry') {
    const p = entryPayload.safeParse(event.payload)
    if (p.success) {
      state.balances[p.data.bucket] += p.data.amountCents
    }
    return
  }
  if (event.type === 'note.added') {
    state.notes += 1
  }
}

/**
 * Pure fold of the event log up to `point` into the state the ledger view shows: the same events
 * give the same state, whatever order they arrive in. A time point includes every event at or
 * before that instant.
 */
export function replayTo(events: readonly ReplayEvent[], point: ReplayPoint): ReplayState {
  const state = emptyState()
  const until = point && 'time' in point ? Date.parse(point.time) : null
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  for (const event of ordered) {
    if (point && 'seq' in point && event.seq > point.seq) {
      break
    }
    if (until !== null && Date.parse(event.occurredAt) > until) {
      break
    }
    apply(state, event)
  }
  return state
}
