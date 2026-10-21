import { useState } from 'react'
import type { Fetcher } from './artifacts'
import { beginDesktopHandoff, desktopReturnUrl } from './passkeys'
import { Frame, PixelButton } from './ui/pixel'

const FAILED = 'The Hall could not hand you back to the app. Try again.'

/**
 * The step after a browser sign-in that the desktop shell asked for (`?desktop=1`): one button
 * mints a single-use code and hands `guildhall://signed-in#code=<code>` to the OS, which opens the
 * app. The code is minted on the click, so it is fresh when the app receives it.
 */
export function DesktopReturn({
  fetcher,
  navigate,
}: {
  fetcher: Fetcher
  /** Hands the url to the OS (assigns it to the window location). */
  navigate: (url: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [opened, setOpened] = useState(false)
  const [error, setError] = useState('')

  async function handBack() {
    setBusy(true)
    setError('')
    try {
      navigate(desktopReturnUrl(await beginDesktopHandoff(fetcher)))
      setOpened(true)
    } catch {
      setError(FAILED)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Frame variant="dialog" className="title-panel">
      <p className="title-line">You are signed in. Return to the app to carry on.</p>
      <div className="title-actions">
        <PixelButton disabled={busy} onClick={handBack}>
          Return to the Guildhall app
        </PixelButton>
      </div>
      {opened && (
        <p role="status" className="title-line">
          The app should open now. If it did not, press the button again.
        </p>
      )}
      <p role="alert" className="title-line">
        {error}
      </p>
    </Frame>
  )
}
