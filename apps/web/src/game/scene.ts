import type { ReplayEvent } from '../replay'
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

/** Folds the roster, Quest facts and event log into the scene state at a point. */
export function deriveScene(input: SceneInput): SceneState {
  return {
    rooms: [],
    members: {},
    stewardId: input.roster.steward.id,
    scrolls: [],
    gateClosed: false,
    coinsCents: 0,
    appliedSeq: 0,
  }
}
