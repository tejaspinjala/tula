import type { GuildMap } from './game/guildmap'

/** Props of {@link MiniMap}. */
export interface MiniMapProps {
  map: GuildMap
  /** Opens the Guild Map page; absent until that page exists. */
  onOpen?: (() => void) | undefined
}

/** The mini map overlay (stub). */
export function MiniMap(_props: MiniMapProps) {
  return null
}
