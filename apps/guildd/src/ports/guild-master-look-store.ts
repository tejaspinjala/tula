import type { CharacterLook } from '../look-catalogue'

/**
 * Port for the Guild Master's character look, kept server-side so it is the same on every device.
 * One look per guild; it is cosmetic and never read by governance.
 */
export interface GuildMasterLookStore {
  /** The saved look, or null when the Guild Master has not customised one yet. */
  get(guildId: string): Promise<CharacterLook | null>
  /** Saves the look, replacing any earlier one. The caller has validated it against the catalogue. */
  set(guildId: string, look: CharacterLook): Promise<void>
}
