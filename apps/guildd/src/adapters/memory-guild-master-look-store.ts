import type { CharacterLook } from '../look-catalogue'
import type { GuildMasterLookStore } from '../ports/guild-master-look-store'

/** Memory {@link GuildMasterLookStore}; state lives in the instance, and each write is one synchronous step. */
export class MemoryGuildMasterLookStore implements GuildMasterLookStore {
  private readonly looks = new Map<string, CharacterLook>()

  async get(guildId: string): Promise<CharacterLook | null> {
    const look = this.looks.get(guildId)
    return look ? { ...look } : null
  }

  async set(guildId: string, look: CharacterLook): Promise<void> {
    this.looks.set(guildId, { ...look })
  }
}
