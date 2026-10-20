import type { Session } from './passkeys'

/** Props of {@link Hud}. */
export interface HudProps {
  session: Session
  guildName: string
  status: 'checking' | 'ok' | 'down'
  /** Changes whenever the HUD should read its numbers again (the Bag closed). */
  refresh: number
  onOpenBag: () => void
  onOpenSeals: () => void
}

/** The heads-up display over the world: the guild name plate, the day, Treasury and Seals. */
export function Hud({ guildName }: HudProps) {
  return <h1 className="hud-plate">{guildName || 'Guildhall'}</h1>
}
