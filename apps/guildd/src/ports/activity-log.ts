import { z } from 'zod'

/**
 * What a Member is doing, as a closed set. A fact the world reads; the engine names it from the
 * tool a Member called or the model turn it is in, never the model.
 */
export const ACTIVITIES = [
  'reading_brief',
  'reading_archive',
  'writing_archive',
  'researching',
  'writing',
  'spawning',
  'waiting',
  'messaging',
  'proposing',
  'thinking',
] as const

/** One of {@link ACTIVITIES}. */
export type Activity = (typeof ACTIVITIES)[number]

/** Zod schema of an {@link Activity}. */
export const activitySchema = z.enum(ACTIVITIES)

/** The payload of a `member.activity` event: ids and the enum, never a tool argument or any text. */
export const memberActivityPayload = z.strictObject({
  questId: z.string(),
  memberId: z.string(),
  hallId: z.string(),
  activity: activitySchema,
  /** The other Hall of a cross-Hall activity (an Inquiry): `hallId` is the source, this the target. */
  peerHallId: z.string().optional(),
})

/** How long repeats of one Member's one activity coalesce into a single event, in milliseconds. */
export const ACTIVITY_WINDOW_MS = 5000

/** One thing a Member did. */
export interface NewActivity {
  questId: string
  memberId: string
  hallId: string
  activity: Activity
  /** The other Hall of a cross-Hall activity: `hallId` is where it came from, this where it went. */
  peerHallId?: string
  /** The instant it happened. */
  at: Date
  /** Repeats of the same Member and activity within this long after an emitted one coalesce. */
  windowMs: number
}

/**
 * The activity log: records what a Member is doing as a `member.activity` event on the guild's
 * stream. Repeats of one Member's one activity inside the window emit once. The check and the
 * append are one durable step, so concurrent and restarted workers agree.
 */
export interface ActivityLog {
  /** Records the activity; `emitted` is false when it coalesced into an earlier event. */
  record(guildId: string, input: NewActivity): Promise<{ emitted: boolean }>
}
