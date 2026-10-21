import type { Fetcher } from './artifacts'
import type { Session } from './passkeys'

/** One Council voice's vote. */
export interface CouncilVoteView {
  voice: string
  vote: string
  reasons: string[]
  abstainCode: string | null
}

/** One Council session as the panel shows it. */
export interface CouncilSessionView {
  id: string
  questId: string
  proposalHash: string
  day: string
  status: string
  reason: string | null
  createdAt: string
  sealId: string | null
  costMicros: number | null
  votes: CouncilVoteView[]
}

/** Reads one page of the Council's sessions, newest first. */
export async function loadCouncilSessions(
  _session: Session,
  _fetcher: Fetcher,
  _query: { limit: number; after?: string }
): Promise<{ sessions: CouncilSessionView[]; next: string | null }> {
  return { sessions: [], next: null }
}

/** The first characters of a Proposal hash. */
export function proposalPrefix(_hash: string): string {
  return ''
}

/** A session's cost as text. */
export function councilCostText(_micros: number | null): string {
  return ''
}

/** A session status in words. */
export function councilStatusLabel(_status: string): string {
  return ''
}

/** A vote in words. */
export function councilVoteLabel(_vote: string): string {
  return ''
}

/** Whether any session is still open. */
export function councilOpenNow(_sessions: readonly { status: string }[]): boolean {
  return false
}
