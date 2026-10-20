import { type Activity, memberActivityPayload } from './game/scene'
import type { ReplayEvent } from './replay'

const WORDS: Record<Activity, string> = {
  reading_brief: 'Reading the brief',
  reading_archive: 'Reading the Archive',
  writing_archive: 'Writing to the Archive',
  researching: 'Researching',
  writing: 'Writing',
  spawning: 'Calling an apprentice',
  waiting: 'Waiting',
  messaging: 'Sending a Missive',
  proposing: 'Proposing a change',
  thinking: 'Thinking',
}

/** One line of a Member's activity feed. */
export interface ActivityEntry {
  seq: number
  questId: string
  label: string
}

/**
 * A Member's recent `member.activity` events, newest first, at most `limit`. Events carry the closed
 * activity name only (never text), so the feed is words from a fixed table. `more` says older ones
 * exist. The events are the guild-scoped, already paginated history plus the live stream.
 */
export function activityFeed(
  events: readonly ReplayEvent[],
  memberId: string,
  limit: number
): { entries: ActivityEntry[]; more: boolean } {
  const all: ActivityEntry[] = []
  for (const event of events) {
    if (event.type !== 'member.activity') {
      continue
    }
    const p = memberActivityPayload.safeParse(event.payload)
    if (p.success && p.data.memberId === memberId) {
      all.push({ seq: event.seq, questId: p.data.questId, label: WORDS[p.data.activity] })
    }
  }
  all.sort((a, b) => b.seq - a.seq)
  return { entries: all.slice(0, limit), more: all.length > limit }
}
