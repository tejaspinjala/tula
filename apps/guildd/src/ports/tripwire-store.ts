import { z } from 'zod'

/** Largest page a {@link TripwireStore.list} call returns. */
export const MAX_TRIPWIRE_PAGE = 100

/** The Tripwires: deterministic rules that pause a Hall (`manual`: the Guild Master paused it). */
export const TRIPWIRE_KINDS = ['token_burn', 'gate_denials', 'loop', 'manual'] as const
/** Which Tripwire paused a Hall. */
export type TripwireKind = (typeof TRIPWIRE_KINDS)[number]

/** What a Tripwire observed and the threshold it crossed; numbers only, never content. */
export const newPause = z.object({
  hallId: z.string().min(1).max(64),
  tripwire: z.enum(TRIPWIRE_KINDS),
  observed: z.number().finite(),
  threshold: z.number().finite(),
})
/** A pause to record. */
export type NewPause = z.infer<typeof newPause>

/** An active pause of one Hall. */
export interface HallPause extends NewPause {
  id: string
  /** Per-guild sequence number; the paging cursor. */
  seq: number
  pausedAt: string
}

/** A page of active pauses, oldest first. */
export interface PausePage {
  pauses: HallPause[]
  /** Cursor for the next page (pass as `after`), or null. */
  next: number | null
}

/**
 * Port for Hall pauses. A Hall has at most one active pause; pausing is immediate and idempotent,
 * resuming removes it. Each change appends a chained event with ids only (`hall.paused`,
 * `hall.resumed`). Whether a caller may resume is decided by the route, never here.
 */
export interface TripwireStore {
  /** Pauses the Hall; if already paused, returns the existing pause with `created: false` and no event. */
  pause(guildId: string, input: NewPause): Promise<{ pause: HallPause; created: boolean }>
  /** Resumes the Hall; false (and no event) when it was not paused. */
  resume(guildId: string, hallId: string): Promise<boolean>
  /** Whether the Hall is paused now. */
  isPaused(guildId: string, hallId: string): Promise<boolean>
  /** Active pauses oldest first, strictly above `after`, at most `limit` (capped at the maximum). */
  list(guildId: string, page: { after?: number; limit: number }): Promise<PausePage>
}
