import type { BuilderConfig, BuilderHall } from './model'

/** The guild-level cap keys the builder edits. */
export type GuildCapKey =
  | 'maxChildrenPerQuest'
  | 'maxSpawnDepth'
  | 'maxQuestsPerCampaign'
  | 'maxInquiriesPerQuest'
  | 'maxBugReportsPerQuest'
  | 'maxDossiersPerQuest'

/** One editable cap: its key, label, bounds and the value the server uses when unset. */
export interface CapField {
  key: GuildCapKey
  label: string
  min: number
  max: number
  fallback: number
}

/** The guild-level caps, with the bounds and defaults of the server's config schema. */
export const GUILD_CAPS: readonly CapField[] = [
  { key: 'maxChildrenPerQuest', label: 'Sub-Quests per Quest', min: 0, max: 20, fallback: 3 },
  { key: 'maxSpawnDepth', label: 'Spawn depth', min: 0, max: 5, fallback: 2 },
  { key: 'maxQuestsPerCampaign', label: 'Quests per Campaign', min: 0, max: 100, fallback: 10 },
  { key: 'maxInquiriesPerQuest', label: 'Inquiries per Quest', min: 0, max: 50, fallback: 3 },
  { key: 'maxBugReportsPerQuest', label: 'Bug Reports per Quest', min: 0, max: 50, fallback: 3 },
  { key: 'maxDossiersPerQuest', label: 'Dossiers per Quest', min: 0, max: 50, fallback: 5 },
]

/** Bounds and default of a Hall's `maxConcurrentMembers`. */
export const HALL_CAP = { min: 1, max: 1000, fallback: 1000 }

/** Sets one guild-level cap. */
export function setGuildCap(c: BuilderConfig, key: GuildCapKey, value: number): BuilderConfig {
  return { ...c, caps: { ...c.caps, [key]: value } }
}

/** Sets a Hall's member cap, or clears it with null (back to no limit). */
export function setHallCap(c: BuilderConfig, hallId: string, value: number | null): BuilderConfig {
  return {
    ...c,
    halls: c.halls.map((h) => {
      if (h.id !== hallId) {
        return h
      }
      const { maxConcurrentMembers: _previous, ...rest } = h
      return value === null ? rest : { ...rest, maxConcurrentMembers: value }
    }),
  }
}

/** The effective value of a guild-level cap (the server default when unset). */
export function guildCapValue(c: BuilderConfig, key: GuildCapKey): number {
  const field = GUILD_CAPS.find((f) => f.key === key)
  return c.caps?.[key] ?? field?.fallback ?? 0
}

/** The effective member cap of a Hall (no limit when unset). */
export function hallCapValue(hall: Pick<BuilderHall, 'maxConcurrentMembers'>): number {
  return hall.maxConcurrentMembers ?? HALL_CAP.fallback
}

/** Ids of the caps a draft raises above the saved config (`guild:<key>` or `hall:<id>`): a client hint only. */
export function widenedCaps(saved: BuilderConfig, draft: BuilderConfig): string[] {
  const guild = GUILD_CAPS.filter((f) => guildCapValue(draft, f.key) > guildCapValue(saved, f.key))
  const halls = draft.halls.filter((h) => {
    const before = saved.halls.find((s) => s.id === h.id)
    return before !== undefined && hallCapValue(h) > hallCapValue(before)
  })
  return [...guild.map((f) => `guild:${f.key}`), ...halls.map((h) => `hall:${h.id}`)]
}

/** The Hall badge text: claimed over cap. */
export function capBadge(claimed: number, hall: Pick<BuilderHall, 'maxConcurrentMembers'>): string {
  return `${claimed} / ${hall.maxConcurrentMembers ?? 'no cap'}`
}
