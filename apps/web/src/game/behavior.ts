import type { Phase } from './daylight'
import type { Spot } from './route'
import type { SceneMember } from './scene'
import { mapData, type PlaceName, placeNamed } from './world'

/** What a Member's sprite does once they arrive at a stop. */
export type Anim =
  | 'idle'
  | 'read'
  | 'write'
  | 'think'
  | 'stand'
  | 'talk'
  | 'summon'
  | 'sleep'
  | 'handin'
  | 'chat'

/** One stop of a plan: where to be, what to do there, and for how long before moving on. */
export interface Stop {
  spot: Spot
  anim: Anim
  /** How long to stay before the next stop; the last stop is where the Member rests. */
  dwellMs: number
  /** True when the Member is out of sight (gone to the Wilds). */
  hidden: boolean
  carry: 'scroll' | null
  /** A line to say on arrival, from the fixed table. */
  line: string | null
}

/** What a Member should be doing: stops in order, under a key that changes when the plan does. */
export interface Plan {
  key: string
  stops: Stop[]
}

/** Everything a plan depends on. Nothing else (no clock, no randomness) may leak in. */
export interface PlanInput {
  /** The guild id: with the Member id it seeds the routine. */
  seed: string
  member: SceneMember
  /** The Member's seat when idle. */
  home: Spot
  /** The Member's desk in their Hall when working. */
  desk: Spot
  phase: Phase
  /** The routine slot of the in-game time (ten minutes each). */
  slot: number
  /** Every idle Member, for pairing chatters. */
  idleIds: readonly string[]
  /** True when the Member just finished a Quest and has not yet handed it in. */
  handIn: boolean
}

/** How long a Member is away in the Wilds when researching, in ms. */
export const RESEARCH_MS = 4000
/** How long a hand-in at the Quest Board takes, in ms. */
export const HAND_IN_MS = 1200

/** What Members say to each other in the plaza: a fixed table, no model calls. */
export const CHATTER: readonly string[] = [
  'Fine weather for a Quest.',
  'Did you see the Quest Board today?',
  'The Archive has a new shelf.',
  'I could do with a warm meal.',
  'The Steward looked busy this morning.',
  'Mind the Treasury; the Crowns go fast.',
  'Quiet in the Hall today.',
  'I heard the Wilds are lovely at dusk.',
]

/** FNV-1a, 32 bits: a small stable hash of a string. */
function hash(text: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const spotOf = (name: PlaceName): Spot => {
  const place = placeNamed(name)
  return { map: place.map, x: place.stand.x, y: place.stand.y }
}

const stop = (spot: Spot, anim: Anim, extra: Partial<Stop> = {}): Stop => ({
  spot,
  anim,
  dwellMs: 0,
  hidden: false,
  carry: null,
  line: null,
  ...extra,
})

/** A plan that keeps someone at a spot all day (the Steward at their desk). */
export function stayAt(spot: Spot, key: string): Plan {
  return { key, stops: [stop(spot, 'idle')] }
}

type RoutineKind = 'desk' | 'wander' | 'browse' | 'chat'

/** The routine kind of a Member in a slot: weighted, from the seed. */
function kindOf(seed: string, id: string, slot: number): RoutineKind {
  const n = hash(`${seed}|${id}|${slot}`) % 8
  if (n < 3) {
    return 'desk'
  }
  if (n < 5) {
    return 'wander'
  }
  return n === 5 ? 'browse' : 'chat'
}

/** Plaza tiles around the Quest Board where two walkers can stand side by side. */
function plazaPairs(): Spot[] {
  const plaza = mapData('plaza')
  const board = placeNamed('quest-board').stand
  const tiles: Spot[] = []
  for (let y = board.y - 2; y <= board.y + 2; y++) {
    for (let x = board.x - 6; x <= board.x + 6; x++) {
      if (plaza.walkable(x, y) && plaza.walkable(x + 1, y)) {
        tiles.push({ map: 'plaza', x, y })
      }
    }
  }
  return tiles
}

/** The idle part of a plan: sleep at night, otherwise the day's routine for this slot. */
function routine(input: PlanInput): Plan {
  const { seed, member, home, slot } = input
  if (input.phase === 'night') {
    return { key: `${member.id}:sleep`, stops: [stop(home, 'sleep')] }
  }
  const kind = kindOf(seed, member.id, slot)
  const key = `${member.id}:${kind}:${slot}`
  if (kind === 'browse') {
    return { key, stops: [stop(spotOf('archive-shelves'), 'read')] }
  }
  const pairs = plazaPairs()
  if (kind === 'chat') {
    const chatters = input.idleIds
      .filter((id) => kindOf(seed, id, slot) === 'chat')
      .sort(
        (a, b) => hash(`${seed}|${slot}|${a}`) - hash(`${seed}|${slot}|${b}`) || (a < b ? -1 : 1)
      )
    const index = chatters.indexOf(member.id)
    const left = index % 2 === 0
    const first = chatters[index - (index % 2)]
    const partner = chatters[left ? index + 1 : index - 1]
    const spot = pairs[hash(`${seed}|${slot}|${first}`) % Math.max(1, pairs.length)]
    if (index >= 0 && partner !== undefined && spot) {
      const line = CHATTER[(hash(`${seed}|${slot}|${first}`) + (left ? 0 : 3)) % CHATTER.length]
      return {
        key,
        stops: [stop({ ...spot, x: spot.x + (left ? 0 : 1) }, 'chat', { line: line ?? null })],
      }
    }
  }
  if (kind === 'desk') {
    return { key, stops: [stop(home, 'idle')] }
  }
  const spot = pairs[hash(`${seed}|${member.id}|${slot}|wander`) % Math.max(1, pairs.length)]
  return { key, stops: [stop(spot ?? home, 'idle')] }
}

/** The stops of a working Member's activity. */
function working(input: PlanInput, name: NonNullable<SceneMember['activity']>['name']): Stop[] {
  const { desk } = input
  switch (name) {
    case 'reading_brief':
    case 'reading_archive':
      return [stop(spotOf('archive-shelves'), 'read')]
    case 'writing_archive':
      return [stop(spotOf('archive-shelves'), 'write')]
    case 'researching':
      return [
        stop(spotOf('wilds'), 'idle', { hidden: true, dwellMs: RESEARCH_MS }),
        stop(desk, 'write', { carry: 'scroll' }),
      ]
    case 'writing':
      return [stop(desk, 'write')]
    case 'spawning':
      return [stop(desk, 'summon')]
    case 'waiting':
      return [stop(spotOf('seal-desk'), 'stand')]
    case 'messaging':
      return [stop(desk, 'talk')]
    case 'proposing':
      return [stop(spotOf('steward-desk'), 'talk')]
    case 'thinking':
      return [stop(desk, 'think')]
  }
}

/**
 * What a Member should be doing now. Pure: the same state, seed and time always give the same
 * plan, so replay scrubbing reproduces the same sequence. The scene only animates the plan.
 */
export function planFor(input: PlanInput): Plan {
  const { member } = input
  if (member.status === 'working') {
    const activity = member.activity
    if (!activity) {
      return { key: `${member.id}:work`, stops: [stop(input.desk, 'idle')] }
    }
    return {
      key: `${member.id}:${activity.name}@${activity.seq}`,
      stops: working(input, activity.name),
    }
  }
  // The Seal desk is shown only when the Member has no active work in hand.
  if (member.awaitingSeal) {
    return { key: `${member.id}:seal`, stops: [stop(spotOf('seal-desk'), 'stand')] }
  }
  const rest = routine(input)
  if (input.handIn) {
    return {
      key: `${member.id}:done@${member.doneSeq ?? 0}`,
      stops: [stop(spotOf('quest-board'), 'handin', { dwellMs: HAND_IN_MS }), ...rest.stops],
    }
  }
  return rest
}
