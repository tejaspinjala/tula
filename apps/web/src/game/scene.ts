import { z } from 'zod'
import { type ReplayEvent, replayTo } from '../replay'
import type { Roster } from '../roster'
import type { LookChoice } from './look'
import type { RoomStyle } from './room'

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
  /** What the Member is doing for the Quest in hand, and the seq of the event that said so. */
  activity?: { name: Activity; seq: number } | undefined
  /** True while the Member's Quest awaits a Seal (they stand at the Seal desk). */
  awaitingSeal?: boolean | undefined
  /** The seq of the Member's latest finished Quest (a new seq hands it in at the Quest Board). */
  doneSeq?: number | undefined
}

/** One room: a Hall, with its Members; locked Halls are shown closed. */
export interface SceneRoom {
  hallId: string
  name: string
  kind: 'work' | 'private'
  locked: boolean
  paused: boolean
  memberIds: string[]
  /** The Guild Master's room style choice for this Hall, if any. */
  roomStyle?: RoomStyle | undefined
  /** Quests on this Hall's Quest Board (queued or in flight); a team Campaign fills it. */
  board: number
}

/** A Sub-Quest's apprentice: joins the parent's room when spawned, leaves when the child settles. */
interface SceneApprentice {
  childId: string
  parentId: string
  hallId: string
  title: string | null
  seq: number
}

/** A courier's one trip between two Halls, raised by the event at `seq`. */
interface SceneCourier {
  seq: number
  fromHall: string
  toHall: string
  /** The Member the trip is for (who gets the "From" bubble on arrival), or null. */
  toMemberId: string | null
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
  /** Couriers that crossed between Halls (the latest few), each walking once. */
  couriers: SceneCourier[]
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
  /** The wall clock (ms) of a live view: a Missive older than {@link BUBBLE_FRESH_MS} pops no bubble. Omit when replaying. */
  now?: number | undefined
}

/** How old a Missive may be, in ms, and still pop a speech bubble. */
const BUBBLE_FRESH_MS = 30_000

const hallPayload = z.object({ hallId: z.string() })
const questPayload = z.object({ questId: z.string() })
const spawnPayload = z.object({ parentId: z.string(), childId: z.string() })
const campaignPayload = z.object({ campaignId: z.string() })
/** What a Member is doing, as guildd names it in a `member.activity` event. */
export const ACTIVITIES = [
  'reading_brief',
  'reading_archive',
  'writing_archive',
  'researching',
  'writing',
  'spawning',
  'waiting',
  'messaging',
  'proposing',
  'thinking',
] as const
/** One of {@link ACTIVITIES}. */
export type Activity = (typeof ACTIVITIES)[number]
/** The payload of a `member.activity` event: ids and the closed activity name, no text. */
export const memberActivityPayload = z.strictObject({
  questId: z.string(),
  memberId: z.string(),
  hallId: z.string(),
  activity: z.enum(ACTIVITIES),
  /** The other Hall a cross-Hall activity is aimed at (a courier walks there). */
  toHallId: z.string().optional(),
})
const missivePayload = z.object({
  missiveId: z.string(),
  from: z.string(),
  to: z.string().optional(),
  hall: z.string().optional(),
  toHall: z.string().optional(),
})
const spendPayload = z.object({ kind: z.string(), amountCents: z.number() })

/** Treasury entry kinds that move operating spend: a reserve is negative, a settle refund or release positive. */
const SPEND_KINDS = new Set(['spend_reserve', 'spend_settle', 'spend_release'])

/** The Hall id a Quest event names (`hallId`, or the Quest Board's `hall`), or undefined. */
function hallOf(payload: unknown): string | undefined {
  const p = z
    .object({ hallId: z.string().optional(), hall: z.string().optional() })
    .safeParse(payload)
  return p.success ? (p.data.hallId ?? p.data.hall) : undefined
}

/** How many of the latest couriers a scene state keeps. */
const MAX_COURIERS = 3

/** Longest missive excerpt a bubble carries. */
const EXCERPT_CHARS = 80

/** Folds the roster, Quest facts and event log into the scene state at a point. */
export function deriveScene(input: SceneInput): SceneState {
  const { roster, events, upTo } = input
  const replay = replayTo(events, upTo === null ? null : { seq: upTo })
  const byId = new Map(input.quests.map((q) => [q.id, q]))
  const hallNames = new Map(roster.halls.map((h) => [h.id, h.name]))
  const claimSeq = new Map<string, number>()
  const claimHall = new Map<string, string>()
  const spawns: { parentId: string; childId: string; seq: number }[] = []
  const campaigns = new Set<string>()
  const sayings = new Map<string, SceneBubble>()
  const saidAt = new Map<string, number>()
  const received = new Map<string, SceneBubble & { at: number }>()
  const couriers: SceneCourier[] = []
  /** The Member a cross-Hall Missive is for: the named one in that Hall, else its Captain or first Member. */
  const addressee = (toHall: string, to: string | undefined): string | null => {
    const hall = roster.halls.find((h) => h.id === toHall)
    const everyone = hall ? [...(hall.captain ? [hall.captain] : []), ...hall.members] : []
    return everyone.find((m) => m.id === to)?.id ?? everyone[0]?.id ?? null
  }
  const activities = new Map<string, { questId: string; name: Activity; seq: number }>()
  const doneAt = new Map<string, number>()
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
    } else if (event.type === 'member.activity') {
      const p = memberActivityPayload.safeParse(event.payload)
      if (p.success) {
        if (p.data.toHallId !== undefined && p.data.toHallId !== p.data.hallId) {
          couriers.push({
            seq: event.seq,
            fromHall: p.data.hallId,
            toHall: p.data.toHallId,
            toMemberId: null,
          })
        }
        activities.set(p.data.memberId, {
          questId: p.data.questId,
          name: p.data.activity,
          seq: event.seq,
        })
      }
    } else if (event.type === 'quest.done') {
      const p = questPayload.safeParse(event.payload)
      const owner = p.success ? byId.get(p.data.questId)?.ownerId : undefined
      if (owner !== undefined) {
        doneAt.set(owner, event.seq)
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
      const toHall = p.success ? p.data.toHall : undefined
      const fromHall = p.success ? p.data.hall : undefined
      const toMemberId = p.success && toHall !== undefined ? addressee(toHall, p.data.to) : null
      if (p.success && toHall !== undefined && fromHall !== undefined) {
        couriers.push({ seq: event.seq, fromHall, toHall, toMemberId })
      }
      if (p.success && text !== undefined) {
        // A Missive that crossed Halls names the Hall it is going to on the sender, and the Hall it
        // came from on the addressee, who sees it when the courier arrives.
        const goingTo = toHall === undefined ? undefined : hallNames.get(toHall)
        const comingFrom = fromHall === undefined ? undefined : hallNames.get(fromHall)
        const spokenAt = Date.parse(event.occurredAt)
        sayings.set(p.data.from, {
          text: goingTo === undefined ? text : `To ${goingTo}: ${text}`,
          seq: event.seq,
        })
        saidAt.set(p.data.from, spokenAt)
        if (toMemberId !== null && comingFrom !== undefined) {
          received.set(toMemberId, {
            text: `From ${comingFrom}: ${text}`,
            seq: event.seq,
            at: spokenAt,
          })
        }
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
        coinsCents = Math.max(0, coinsCents - p.data.amountCents)
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
      kind: hall.kind,
      locked: hall.locked,
      paused: paused.has(hall.id),
      memberIds: everyone.map((m) => m.id),
      ...(hall.roomStyle ? { roomStyle: hall.roomStyle } : {}),
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
      const doing = activities.get(member.id)
      if (doing && doing.questId === quest.id) {
        member.activity = { name: doing.name, seq: doing.seq }
      }
    }
  }
  for (const questId of replay.quests.awaiting_seal) {
    const member = members[byId.get(questId)?.ownerId ?? '']
    if (member) {
      member.awaitingSeal = true
    }
  }
  for (const [memberId, seq] of doneAt) {
    const member = members[memberId]
    if (member) {
      member.doneSeq = seq
    }
  }
  for (const [memberId, saying] of sayings) {
    const member = members[memberId]
    if (member) {
      const said = { text: saying.text.slice(0, EXCERPT_CHARS), seq: saying.seq }
      member.saying = said
      const spoken = saidAt.get(memberId)
      // Only a live (or just-now) Missive pops a bubble; an old one would replay on every page load.
      const stale =
        input.now !== undefined && spoken !== undefined && input.now - spoken > BUBBLE_FRESH_MS
      if (!stale && (member.bubble === null || said.seq > member.bubble.seq)) {
        member.bubble = said
      }
    }
  }
  for (const [memberId, got] of received) {
    const member = members[memberId]
    const stale = input.now !== undefined && input.now - got.at > BUBBLE_FRESH_MS
    if (member && !stale && (member.bubble === null || got.seq > member.bubble.seq)) {
      member.bubble = { text: got.text.slice(0, EXCERPT_CHARS), seq: got.seq }
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
    couriers: couriers.slice(-MAX_COURIERS),
    coinsCents,
    appliedSeq: replay.appliedSeq,
  }
}
