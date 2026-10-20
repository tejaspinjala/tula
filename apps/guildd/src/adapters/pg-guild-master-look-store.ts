import type { Db } from '../db/client'
import type { CharacterLook } from '../look-catalogue'
import type { GuildMasterLookStore } from '../ports/guild-master-look-store'

/** Postgres {@link GuildMasterLookStore}: a stub until the contract drives it. */
export class PgGuildMasterLookStore implements GuildMasterLookStore {
  constructor(readonly db: Db) {}

  async get(_guildId: string): Promise<CharacterLook | null> {
    return null
  }

  async set(_guildId: string, _look: CharacterLook): Promise<void> {}
}
