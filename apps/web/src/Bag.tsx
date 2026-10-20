import type { ReactNode } from 'react'
import type { Session } from './passkeys'
import type { PageId } from './router'

/** Props of {@link Bag}. */
export interface BagProps {
  session: Session
  onSession: (session: Session | null) => void
  /** Whether the Bag overlay is showing (the menu, or a page when `page` is set). */
  visible: boolean
  page: PageId | null
  /** The Hall tools page content (zoom, teleport, replay, character). */
  hallControls: ReactNode
  onOpenPath: (path: string) => void
  /** Back to the Bag menu. */
  onMenu: () => void
  /** Close the Bag and return to the walk. */
  onClose: () => void
  onSignOut: () => void
  /** Returns keyboard focus to the world. */
  focusWorld: () => void
}

/** The Bag: a ▶ menu of pages, each opening as a framed overlay over a dimmed world. */
export function Bag(_props: BagProps) {
  return null
}
