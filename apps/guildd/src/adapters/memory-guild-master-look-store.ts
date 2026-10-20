import type { CharacterLook } from '../look-catalogue'
import type { GuildMasterLookStore } from '../ports/guild-master-look-store'

/** Memory {@link GuildMasterLookStore}: a stub until the contract drives it. */
export class MemoryGuildMasterLookStore implements GuildMasterLookStore {
  async get(_guildId: string): Promise<CharacterLook | null> {
    return null
  }

  async set(_guildId: string, _look: CharacterLook): Promise<void> {}
}
