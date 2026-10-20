import type { Fetcher } from './artifacts'
import type { LookChoice } from './game/look'
import type { Session } from './passkeys'

/** Props of {@link CharacterPanel}. */
export interface CharacterPanelProps {
  session: Session
  fetcher: Fetcher
  /** The saved look, or null when none is saved yet (the default is then the starting point). */
  saved: LookChoice | null
  /** Called with every draft change, so the hall can show it live. */
  onPreview: (look: LookChoice) => void
  /** Called with the look the server stored. */
  onSaved: (look: LookChoice) => void
  /** Called when the Guild Master closes the screen without saving. */
  onCancel: () => void
}

/** The character customization screen (stub). */
export function CharacterPanel(_props: CharacterPanelProps) {
  return null
}
