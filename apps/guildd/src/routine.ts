import type { Verdict } from './ports/proposal-store'
import type { DataClass } from './ports/quest-queue'

/** The facts {@link isRoutine} decides on; every one comes from code or stored state, never a model. */
export interface RoutineFacts {
  /** The Quest template's code-only routine-eligible flag. */
  templateRoutineEligible: boolean
  /** The Quest's data class. */
  dataClass: DataClass
  /** SHA-256 of the exact Proposal content being judged. */
  proposalHash: string
  /** The Verdict stored for that Proposal, or null when there is none. */
  verdict: Verdict | null
  /** Council approvals the guild may still give today under its cap. */
  approvalsRemainingToday: number
}

/**
 * Whether a Proposal is a routine Proposal: its Quest template is routine-eligible, its data class
 * is not private, the Verdict on exactly this Proposal hash passed, and the guild has Council
 * approvals left today. Pure and deterministic: nothing a model says can make a Proposal routine.
 */
export function isRoutine(facts: RoutineFacts): boolean {
  return (
    facts.templateRoutineEligible &&
    facts.dataClass !== 'private' &&
    facts.verdict !== null &&
    facts.verdict.passed &&
    facts.verdict.proposalHash === facts.proposalHash &&
    facts.approvalsRemainingToday > 0
  )
}
