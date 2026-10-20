import type { Vec } from './walk'

/** Something the Guild Master can talk to: a Member, or the Seal desk. */
export type Target = { kind: 'member'; id: string } | { kind: 'sealDesk' }

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
  return a.kind === b.kind
}

/** The next interaction state. */
export function talkReducer(state: TalkState, action: TalkAction): TalkState {
  switch (action.type) {
    case 'near':
      return sameTarget(state.near, action.target) ? state : { ...state, near: action.target }
    case 'interact':
      return state.open !== null || state.near === null
        ? state
        : { ...state, open: state.near, form: 'view' }
    case 'inspect':
    case 'talk':
      return state
    case 'assign':
      return state.open?.kind === 'member' ? { ...state, form: 'assign' } : state
    case 'back':
      return { ...state, form: 'view' }
    case 'close':
      return { ...state, open: null, form: 'view' }
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
