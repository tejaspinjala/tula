import type { Verdict } from './ports/proposal-store'
import type { DataClass } from './ports/quest-queue'

/** The facts {@link isRoutine} decides on. */
export interface RoutineFacts {
  templateRoutineEligible: boolean
  dataClass: DataClass
  proposalHash: string
  verdict: Verdict | null
  approvalsRemainingToday: number
}

/** Stub: filled in by the green commit. */
export function isRoutine(_facts: RoutineFacts): boolean {
  return false
}
