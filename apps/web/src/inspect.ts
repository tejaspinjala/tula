import type { ReplayEvent } from './replay'

/** One line of a Member's activity feed. */
export interface ActivityEntry {
  seq: number
  questId: string
  label: string
}

/** A Member's recent `member.activity` events, newest first, at most `limit` (stub: nothing yet). */
export function activityFeed(
  _events: readonly ReplayEvent[],
  _memberId: string,
  _limit: number
): { entries: ActivityEntry[]; more: boolean } {
  return { entries: [], more: false }
}
