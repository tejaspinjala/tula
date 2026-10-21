import type { Clock } from '../ports/clock'
import type { PresenceState, PresenceStore } from '../ports/presence-store'

/** Memory {@link PresenceStore}. */
export class MemoryPresenceStore implements PresenceStore {
  constructor(readonly clock: Clock) {}

  async get(_guildId: string): Promise<PresenceState> {
    throw new Error('not implemented')
  }

  async goAway(_guildId: string, _until: string | null): Promise<PresenceState> {
    throw new Error('not implemented')
  }

  async returnHome(_guildId: string): Promise<boolean> {
    throw new Error('not implemented')
  }
}
