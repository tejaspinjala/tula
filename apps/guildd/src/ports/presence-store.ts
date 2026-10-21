/** The Guild Master's presence as stored: away or present, since when, and until when. */
export interface PresenceState {
  away: boolean
  /** ISO instant the Guild Master went away; null when present. */
  since: string | null
  /** ISO instant away mode ends by itself; null for no return time or when present. */
  until: string | null
}

/**
 * Whether the Guild Master counts as away at `now`. A passed return time counts as present, so
 * away mode ends by itself without a write. Pure; the Council reads presence through this.
 */
export function isAway(_state: PresenceState, _now: Date): boolean {
  return false
}

/**
 * Port for the Guild Master's presence (away mode): one state per guild. Away mode is runtime
 * state, never config, and narrows nothing, so changing it needs a session but no Seal.
 */
export interface PresenceStore {
  /** The stored state; use {@link isAway} for whether the Guild Master counts as away now. */
  get(guildId: string): Promise<PresenceState>
  /** Marks the Guild Master away until `until` (ISO instant) or until they return; one audit event. */
  goAway(guildId: string, until: string | null): Promise<PresenceState>
  /** Returns the Guild Master; true when away mode was on (one audit event), false otherwise. */
  returnHome(guildId: string): Promise<boolean>
}
