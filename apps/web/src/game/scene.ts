import { z } from 'zod'
import { type ReplayEvent, replayTo } from '../replay'
import type { Roster } from '../roster'

/** The Steward and Halls the hall is built from (the ledger's roster). */
export type SceneRoster = Roster

/** The Quest facts the events do not carry: its title, Hall and owning Member. */
export interface SceneQuest {
  id: string
  title: string
  hallId: string
  ownerId: string
}

/** A speech bubble: the text and the seq of the event that raised it (a new seq is a new bubble). */
export interface SceneBubble {
  text: string
  seq: number
}

/** One Member of the hall. */
export interface SceneMember {
  id: string
  name: string
  hallId: string
  rank: string
  status: 'idle' | 'working'
  questId: string | null
  bubble: SceneBubble | null
}

/** One room: a Hall, with its Members; locked Halls are shown closed. */
export interface SceneRoom {
  hallId: string
  name: string
  locked: boolean
  paused: boolean
  memberIds: string[]
}

/** Everything the game draws, derived from the event log; the game decides nothing. */
export interface SceneState {
  rooms: SceneRoom[]
  members: Record<string, SceneMember>
  stewardId: string
  /** Quests awaiting a Seal, shown as scrolls at the Seal desk. */
  scrolls: { questId: string; title: string }[]
  gateClosed: boolean
  /** Treasury spend so far, in cents. */
  coinsCents: number
  appliedSeq: number
}

/** The inputs of one derivation. */
export interface SceneInput {
  roster: SceneRoster
  quests: readonly SceneQuest[]
  events: readonly ReplayEvent[]
  /** Fold events up to and including this seq; null folds them all. */
  upTo: number | null
}

const hallPayload = z.object({ hallId: z.string() })
const questPayload = z.object({ questId: z.string() })
const spendPayload = z.object({ kind: z.string(), amountCents: z.number() })

/** Treasury entry kinds that are money leaving the guild. */
const SPEND_KINDS = new Set(['spend_settle'])

/** Folds the roster, Quest facts and event log into the scene state at a point. */
export function deriveScene(input: SceneInput): SceneState {
  const { roster, events, upTo } = input
  const replay = replayTo(events, upTo === null ? null : { seq: upTo })
  const byId = new Map(input.quests.map((q) => [q.id, q]))
  const claimSeq = new Map<string, number>()
  const paused = new Set<string>()
  let gateClosed = false
  let coinsCents = 0
  const ordered = [...events].sort((a, b) => a.seq - b.seq)
  for (const event of ordered) {
    if (upTo !== null && event.seq > upTo) {
      break
    }
    if (event.type === 'gates.barred') {
      gateClosed = true
    } else if (event.type === 'gates.lifted') {
      gateClosed = false
    } else if (event.type === 'quest.claimed') {
      const p = questPayload.safeParse(event.payload)
      if (p.success) {
        claimSeq.set(p.data.questId, event.seq)
      }
    } else if (event.type === 'hall.paused' || event.type === 'hall.resumed') {
      const p = hallPayload.safeParse(event.payload)
      if (p.success) {
        if (event.type === 'hall.paused') {
          paused.add(p.data.hallId)
        } else {
          paused.delete(p.data.hallId)
        }
      }
    } else if (event.type === 'treasury.entry') {
      const p = spendPayload.safeParse(event.payload)
      if (p.success && SPEND_KINDS.has(p.data.kind)) {
        coinsCents += Math.abs(p.data.amountCents)
      }
    }
  }

  const members: Record<string, SceneMember> = {}
  const rooms: SceneRoom[] = roster.halls.map((hall) => {
    // The roster lists the Captain apart from the Members; the Captain works in the room too.
    const everyone = [
      ...(hall.captain && !hall.members.some((m) => m.id === hall.captain?.id)
        ? [{ id: hall.captain.id, name: hall.captain.name, rank: 'captain' }]
        : []),
      ...hall.members,
    ]
    for (const m of everyone) {
      members[m.id] = {
        id: m.id,
        name: m.name,
        hallId: hall.id,
        rank: m.rank,
        status: 'idle',
        questId: null,
        bubble: null,
      }
    }
    return {
      hallId: hall.id,
      name: hall.name,
      locked: hall.locked,
      paused: paused.has(hall.id),
      memberIds: everyone.map((m) => m.id),
    }
  })
  for (const questId of replay.quests.active) {
    const quest = byId.get(questId)
    const member = quest ? members[quest.ownerId] : undefined
    if (quest && member) {
      member.status = 'working'
      member.questId = quest.id
      const at = claimSeq.get(quest.id)
      member.bubble = at === undefined ? null : { text: quest.title, seq: at }
    }
  }
  const scrolls = replay.quests.awaiting_seal.flatMap((questId) => {
    const quest = byId.get(questId)
    return quest ? [{ questId, title: quest.title }] : []
  })
  return {
    rooms,
    members,
    stewardId: roster.steward.id,
    scrolls,
    gateClosed,
    coinsCents,
    appliedSeq: replay.appliedSeq,
  }
}
