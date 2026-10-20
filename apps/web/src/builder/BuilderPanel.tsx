import type { Fetcher } from '../artifacts'
import type { PasskeyBrowser, Session } from '../passkeys'

/** Props of {@link BuilderPanel}. */
export interface BuilderPanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Forces the desktop canvas (true) or the phone's read-only tree (false); default follows the screen width. */
  desktop?: boolean
}

/** The Guild builder: a drag-and-drop canvas for Halls and Members, saved as versioned config. */
export function BuilderPanel(_props: BuilderPanelProps) {
  return null
}
