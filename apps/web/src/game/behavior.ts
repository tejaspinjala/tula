import type { Phase } from './daylight'
import type { Spot } from './route'
import type { SceneMember } from './scene'

/** Placeholder until the behaviour lands. */
export type Anim = string
/** Placeholder. */
export interface Stop {
  spot: Spot
  anim: Anim
  dwellMs: number
  hidden: boolean
  carry: 'scroll' | null
  line: string | null
}
/** Placeholder. */
export interface Plan {
  key: string
  stops: Stop[]
}
/** Placeholder. */
export interface PlanInput {
  seed: string
  member: SceneMember
  home: Spot
  desk: Spot
  phase: Phase
  slot: number
  idleIds: readonly string[]
  handIn: boolean
}
/** Placeholder. */
export const CHATTER: readonly string[] = []
/** Placeholder. */
export function planFor(_input: PlanInput): Plan {
  throw new Error('not implemented')
}
