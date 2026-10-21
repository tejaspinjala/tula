import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type { PresenceState, PresenceStore } from '../ports/presence-store'

/** Postgres {@link PresenceStore}. */
export class PgPresenceStore implements PresenceStore {
  constructor(
    readonly db: Db,
    readonly keys: KeyProvider,
    readonly clock: Clock
  ) {}

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
