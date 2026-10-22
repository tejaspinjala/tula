import type { Vec } from './walk'

/** Something the Guild Master can talk to: a Member, the Seal desk, a Hall's mailbox or the Council chamber. */
export type Target =
  | { kind: 'member'; id: string }
  | { kind: 'sealDesk' }
  | { kind: 'mailbox'; hallId: string }
  | { kind: 'council' }

/** What the interaction knows: who is in reach, what is open, and which form shows. */
export interface TalkState {
  near: Target | null
  open: Target | null
  /** The Member whose inspect card is showing (a click, or E next to them). */
  inspect: string | null
  form: 'view' | 'assign'
}

/** What can happen to an interaction. */
export type TalkAction =
  | { type: 'near'; target: Target | null }
  | { type: 'interact' }
  | { type: 'inspect'; id: string }
  | { type: 'talk' }
  | { type: 'assign' }
  | { type: 'back' }
  | { type: 'close' }

/** How far, in tiles, the Guild Master can reach to talk. */
export const REACH = 1.6

/** The start state: nobody in reach, nothing open. */
export const initialTalk: TalkState = { near: null, open: null, inspect: null, form: 'view' }

/** True when two targets are the same Member or both the Seal desk. */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) {
    return a === b
  }
  if (a.kind === 'member' && b.kind === 'member') {
    return a.id === b.id
  }
  if (a.kind === 'mailbox' && b.kind === 'mailbox') {
    return a.hallId === b.hallId
  }
  return a.kind === b.kind
}

/** The next interaction state. */
export function talkReducer(state: TalkState, action: TalkAction): TalkState {
  switch (action.type) {
    case 'near':
      return sameTarget(state.near, action.target) ? state : { ...state, near: action.target }
    case 'interact':
      if (state.open !== null || state.inspect !== null || state.near === null) {
        return state
      }
      return state.near.kind === 'member'
        ? { ...state, inspect: state.near.id, form: 'view' }
        : { ...state, open: state.near, form: 'view' }
    case 'inspect':
      return state.open !== null ? state : { ...state, inspect: action.id, form: 'view' }
    case 'talk':
      return state.inspect === null
        ? state
        : { ...state, open: { kind: 'member', id: state.inspect }, inspect: null, form: 'view' }
    case 'assign':
      return state.open?.kind === 'member' ? { ...state, form: 'assign' } : state
    case 'back':
      return { ...state, form: 'view' }
    case 'close':
      return { ...state, open: null, inspect: null, form: 'view' }
  }
}

/** The closest target within `reach` tiles of the player, or null. */
export function nearestTarget(
  player: Vec,
  targets: readonly { target: Target; at: Vec }[],
  reach: number
): Target | null {
  let best: Target | null = null
  let bestGap = reach
  for (const { target, at } of targets) {
    const gap = Math.hypot(at.x - player.x, at.y - player.y)
    if (gap <= bestGap) {
      best = target
      bestGap = gap
    }
  }
  return best
}

/** The point of a tile rectangle nearest `from`, at tile centres: reach a desk's edge, not its middle. */
export function reachPoint(_rect: { x: number; y: number; w: number; h: number }, _from: Vec): Vec {
  throw new Error('todo')
}
