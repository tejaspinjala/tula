import type { Fetcher } from './artifacts'
import type { SceneState } from './game/scene'
import type { Session } from './passkeys'
import type { ReplayEvent } from './replay'

/** What the inspect card needs from the page. */
export interface InspectCardProps {
  session: Session
  fetcher: Fetcher
  /** The Member inspected, or null with the card closed. */
  memberId: string | null
  scene: SceneState | null
  quests: readonly { id: string; title: string; state?: string }[]
  events: readonly ReplayEvent[]
  onTalk: () => void
  onFollow: (memberId: string) => void
  onClose: () => void
}

/** A framed card on one Member: its Quest, live activity, Missives, Talk and Follow (stub). */
export function InspectCard(_props: InspectCardProps) {
  return null
}
