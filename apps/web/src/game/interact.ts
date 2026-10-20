import type { Vec } from './walk'

/** Something the Guild Master can talk to: a Member, or the Seal desk. */
export type Target = { kind: 'member'; id: string } | { kind: 'sealDesk' }

/** What the interaction knows: who is in reach, what is open, and which form shows. */
export interface TalkState {
  near: Target | null
  open: Target | null
  form: 'view' | 'assign'
}

/** What can happen to an interaction. */
export type TalkAction =
  | { type: 'near'; target: Target | null }
  | { type: 'interact' }
  | { type: 'assign' }
  | { type: 'back' }
  | { type: 'close' }

/** How far, in tiles, the Guild Master can reach to talk. */
export const REACH = 1.6

/** The start state: nobody in reach, nothing open. */
export const initialTalk: TalkState = { near: null, open: null, form: 'view' }

/** True when two targets are the same Member or both the Seal desk. */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  return a === b
}

/** The next interaction state. */
export function talkReducer(state: TalkState, _action: TalkAction): TalkState {
  return state
}

/** The closest target within `reach` tiles of the player, or null. */
export function nearestTarget(
  _player: Vec,
  _targets: readonly { target: Target; at: Vec }[],
  _reach: number
): Target | null {
  return null
}
