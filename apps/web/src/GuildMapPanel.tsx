import type { GuildMap } from './game/guildmap'
import type { MapKey } from './game/world'

/** Props of {@link GuildMapPanel}. */
export interface GuildMapPanelProps {
  map: GuildMap | null
  /** Takes the Guild Master to a room (the existing teleport path). */
  onTravel: (id: MapKey) => void
}

/** The Guild Map page: a schematic of the rooms joined by doorway lines, and a list view of the same rooms. */
export function GuildMapPanel(_props: GuildMapPanelProps) {
  return null
}
