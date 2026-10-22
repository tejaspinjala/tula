import type { Fetcher } from '../artifacts'
import type { PasskeyBrowser, Session } from '../passkeys'

/** Props of {@link CharterPanel}. */
export interface CharterPanelProps {
  session: Session
  fetcher?: Fetcher
  browser?: PasskeyBrowser
  /** Saves the exported file; defaults to a browser download. */
  download?: (filename: string, text: string) => void
}

/** The Charter page: export the guild, or import a Charter with a preview first. */
export function CharterPanel(_props: CharterPanelProps) {
  return null
}
