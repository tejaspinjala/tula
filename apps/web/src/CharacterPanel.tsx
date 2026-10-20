import { useState } from 'react'
import type { Fetcher } from './artifacts'
import { LookPicker, LookPreview } from './game/LookPicker'
import { choiceFor, GUILD_MASTER_ID, type LookChoice } from './game/look'
import { saveGuildMasterLook } from './guild-master-look'
import type { Session } from './passkeys'
import { Frame, PixelButton } from './ui/pixel'

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

/**
 * The character customization screen: one choice per catalogue part, a live preview here and in
 * the hall, and a save to the server (never browser storage) so the character is the same on every
 * device.
 */
export function CharacterPanel({
  session,
  fetcher,
  saved,
  onPreview,
  onSaved,
  onCancel,
}: CharacterPanelProps) {
  const start = saved ?? choiceFor(GUILD_MASTER_ID)
  const [draft, setDraft] = useState<LookChoice>(start)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  const change = (next: LookChoice) => {
    setDraft(next)
    onPreview(next)
  }

  const save = async () => {
    setBusy(true)
    setFailed(false)
    try {
      onSaved(await saveGuildMasterLook(session, fetcher, draft))
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section aria-labelledby="character-heading" className="character-panel">
      <Frame variant="paper">
        <h3 id="character-heading" className="work-sub">
          Your character
        </h3>
        <div className="look-editor">
          <LookPreview look={draft} label="Your character" />
          <LookPicker look={draft} onChange={change} />
        </div>
        <div className="work-actions">
          <PixelButton disabled={busy} onClick={save}>
            Save character
          </PixelButton>
          <PixelButton
            onClick={() => {
              onPreview(start)
              onCancel()
            }}
          >
            Cancel
          </PixelButton>
        </div>
        {failed && <p role="alert">Your character could not be saved. Try again.</p>}
      </Frame>
    </section>
  )
}
