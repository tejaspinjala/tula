import { z } from 'zod'
import { type ReplayEvent, replayTo } from '../replay'
import type { Roster } from '../roster'
import type { LookChoice } from './look'

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
  /** The title of the Quest in hand (the live region names it even while a Missive is spoken). */
  questTitle?: string | undefined
  bubble: SceneBubble | null
  /** The seq of the claim that put this Member to work (a new seq walks them to the Quest Board). */
  claimSeq: number | null
  /** The Member's latest Missive, as text (the bubble shows it while it is the newest thing said). */
  saying?: SceneBubble | undefined
  /** The Guild Master's override of the look this Member's id seeds. */
  look?: LookChoice | undefined
}

/** One room: a Hall, with its Members; locked Halls are shown closed. */
export interface SceneRoom {
  hallId: string
  name: string
  locked: boolean
  paused: boolean
  memberIds: string[]
  /** Quests on this Hall's Quest Board (queued or in flight); a team Campaign fills it. */
  board: number
}

/** A Sub-Quest's apprentice: joins the parent's room when spawned, leaves when the child settles. */
export interface SceneApprentice {
  childId: string
  parentId: string
  hallId: string
  title: string | null
  seq: number
}

/** Everything the game draws, derived from the event log; the game decides nothing. */
export interface SceneState {
  rooms: SceneRoom[]
  members: Record<string, SceneMember>
  stewardId: string
  /** Quests awaiting a Seal, shown as scrolls at the Seal desk. */
  scrolls: { questId: string; title: string }[]
  /** Apprentices of spawned Sub-Quests still in flight. */
  apprentices: SceneApprentice[]
  /** Team Campaigns with Quests still on the boards. */
  campaigns: string[]
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
  /** Missive text by Missive id, fetched from the Hall route (events carry ids only). */
  missiveTexts?: Readonly<Record<string, string>> | undefined
}

const hallPayload = z.object({ hallId: z.string() })
const questPayload = z.object({ questId: z.string() })
const spawnPayload = z.object({ parentId: z.string(), childId: z.string() })
const campaignPayload = z.object({ campaignId: z.string() })
/** Stub: the `member.activity` payload schema. */
export const memberActivityPayload = z.looseObject({})
const missivePayload = z.object({ missiveId: z.string(), from: z.string() })
const spendPayload = z.object({ kind: z.string(), amountCents: z.number() })

/** Treasury entry kinds that are money leaving the guild. */
const SPEND_KINDS = new Set(['spend_settle'])

/** The Hall id a Quest event names (`hallId`, or the Quest Board's `hall`), or undefined. */
function hallOf(payload: unknown): string | undefined {
  const p = z
    .object({ hallId: z.string().optional(), hall: z.string().optional() })
    .safeParse(payload)
  return p.success ? (p.data.hallId ?? p.data.hall) : undefined
}

/** Longest missive excerpt a bubble carries. */
const EXCERPT_CHARS = 80

/** Folds the roster, Quest facts and event log into the scene state at a point. */
export function deriveScene(input: SceneInput): SceneState {
  const { roster, events, upTo } = input
  const replay = replayTo(events, upTo === null ? null : { seq: upTo })
  const byId = new Map(input.quests.map((q) => [q.id, q]))
  const claimSeq = new Map<string, number>()
  const claimHall = new Map<string, string>()
  const spawns: { parentId: string; childId: string; seq: number }[] = []
  const campaigns = new Set<string>()
  const sayings = new Map<string, SceneBubble>()
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
        const hall = hallOf(event.payload)
        if (hall !== undefined) {
          claimHall.set(p.data.questId, hall)
        }
      }
    } else if (event.type === 'quest.spawned') {
      const p = spawnPayload.safeParse(event.payload)
      if (p.success) {
        spawns.push({ parentId: p.data.parentId, childId: p.data.childId, seq: event.seq })
      }
    } else if (event.type === 'campaign.started' || event.type === 'campaign.finished') {
      const p = campaignPayload.safeParse(event.payload)
      if (p.success) {
        if (event.type === 'campaign.started') {
          campaigns.add(p.data.campaignId)
        } else {
          campaigns.delete(p.data.campaignId)
        }
      }
    } else if (event.type === 'missive.sent') {
      const p = missivePayload.safeParse(event.payload)
      const text = p.success ? input.missiveTexts?.[p.data.missiveId] : undefined
      if (p.success && text !== undefined) {
        sayings.set(p.data.from, { text, seq: event.seq })
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
    const everyone: Array<{
      id: string
      name: string
      rank: string
      look?: LookChoice | undefined
    }> = [
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
        claimSeq: null,
        ...(m.look ? { look: m.look } : {}),
      }
    }
    return {
      hallId: hall.id,
      name: hall.name,
      locked: hall.locked,
      paused: paused.has(hall.id),
      memberIds: everyone.map((m) => m.id),
      board: 0,
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
      member.claimSeq = at ?? null
      member.questTitle = quest.title
    }
  }
  for (const [memberId, saying] of sayings) {
    const member = members[memberId]
    if (member) {
      const said = { text: saying.text.slice(0, EXCERPT_CHARS), seq: saying.seq }
      member.saying = said
      if (member.bubble === null || said.seq > member.bubble.seq) {
        member.bubble = said
      }
    }
  }
  const settled = new Set([...replay.quests.done, ...replay.quests.dead])
  const apprentices: SceneApprentice[] = spawns.flatMap((spawn) => {
    const hallId =
      byId.get(spawn.parentId)?.hallId ??
      claimHall.get(spawn.parentId) ??
      byId.get(spawn.childId)?.hallId
    if (
      settled.has(spawn.childId) ||
      hallId === undefined ||
      !rooms.some((r) => r.hallId === hallId)
    ) {
      return []
    }
    return [
      {
        childId: spawn.childId,
        parentId: spawn.parentId,
        hallId,
        title: byId.get(spawn.childId)?.title ?? null,
        seq: spawn.seq,
      },
    ]
  })
  for (const questId of [
    ...replay.quests.queued,
    ...replay.quests.active,
    ...replay.quests.awaiting_seal,
  ]) {
    const room = rooms.find((r) => r.hallId === byId.get(questId)?.hallId)
    if (room) {
      room.board += 1
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
    apprentices,
    campaigns: [...campaigns],
    gateClosed,
    coinsCents,
    appliedSeq: replay.appliedSeq,
  }
}
