/**
 * The thought bubble of a Member at work: while their Quest is active and they stand at their
 * station, a small bubble keeps the Quest's title (cut short) over their head. Pure; the scene
 * draws what this returns.
 */

/** Longest title a thought bubble carries before the tilde. */
export const THOUGHT_CHARS = 16

/** What a thought bubble needs to know about a Member. */
export interface ThoughtMember {
  status: 'idle' | 'working'
  questTitle?: string | undefined
}

/** What the Member is doing on the map: standing at the station, or on the move. */
export type ThoughtMotion = 'station' | 'moving'

/** The text of a Member's thought bubble, or null when they have none to show. */
export function thoughtText(
  member: ThoughtMember,
  motion: ThoughtMotion,
  speaking: boolean
): string | null {
  const title = member.questTitle?.trim() ?? ''
  if (member.status !== 'working' || title === '' || motion !== 'station' || speaking) {
    return null
  }
  return title.length > THOUGHT_CHARS ? `${title.slice(0, THOUGHT_CHARS - 1).trimEnd()}~` : title
}
