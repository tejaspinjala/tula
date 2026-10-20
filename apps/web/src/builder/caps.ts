import type { BuilderConfig, BuilderHall } from './model'

/** The guild-level cap keys the builder edits. */
export type GuildCapKey = 'maxChildrenPerQuest' | 'maxSpawnDepth' | 'maxQuestsPerCampaign'

/** One editable cap: its key, label, bounds and the value the server uses when unset. */
export interface CapField {
  key: GuildCapKey
  label: string
  min: number
  max: number
  fallback: number
}

/** The guild-level caps, with the bounds and defaults of the server's config schema. */
export const GUILD_CAPS: readonly CapField[] = []

/** Bounds and default of a Hall's `maxConcurrentMembers`. */
export const HALL_CAP = { min: 1, max: 1000, fallback: 1000 }

/** Sets one guild-level cap. */
export function setGuildCap(c: BuilderConfig, _key: GuildCapKey, _value: number): BuilderConfig {
  return c
}

/** Sets a Hall's member cap, or clears it with null (back to no limit). */
export function setHallCap(
  c: BuilderConfig,
  _hallId: string,
  _value: number | null
): BuilderConfig {
  return c
}

/** The effective value of a guild-level cap (the server default when unset). */
export function guildCapValue(_c: BuilderConfig, _key: GuildCapKey): number {
  return -1
}

/** The effective member cap of a Hall (no limit when unset). */
export function hallCapValue(_hall: Pick<BuilderHall, 'maxConcurrentMembers'>): number {
  return -1
}

/** Ids of the caps a draft raises above the saved config (`guild:<key>` or `hall:<id>`): a client hint only. */
export function widenedCaps(_saved: BuilderConfig, _draft: BuilderConfig): string[] {
  return []
}

/** The Hall badge text: claimed over cap. */
export function capBadge(
  _claimed: number,
  _hall: Pick<BuilderHall, 'maxConcurrentMembers'>
): string {
  return ''
}
