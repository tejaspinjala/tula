import type { Clock } from '../ports/clock'
import { isAway, type PresenceState, type PresenceStore } from '../ports/presence-store'

const PRESENT: PresenceState = { away: false, since: null, until: null }

/** Memory {@link PresenceStore}: state in this instance only; each write is one synchronous step. */
export class MemoryPresenceStore implements PresenceStore {
  private readonly states = new Map<string, PresenceState>()

  constructor(private readonly clock: Clock) {}

  async get(guildId: string): Promise<PresenceState> {
    return { ...(this.states.get(guildId) ?? PRESENT) }
  }

  async goAway(guildId: string, until: string | null): Promise<PresenceState> {
    const now = this.clock.now()
    const current = this.states.get(guildId) ?? PRESENT
    // Still away (return time not passed): keep when it began. Otherwise it begins now.
    const since = isAway(current, now) && current.since ? current.since : now.toISOString()
    const next: PresenceState = { away: true, since, until }
    this.states.set(guildId, next)
    return { ...next }
  }

  async returnHome(guildId: string): Promise<boolean> {
    const was = this.states.get(guildId)?.away === true
    this.states.delete(guildId)
    return was
  }
}
