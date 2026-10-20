import { useEffect, useId, useRef, useState } from 'react'
import type { Fetcher } from './artifacts'
import { FoundGuildPanel } from './FoundGuildPanel'
import {
  type FoundingState,
  type PasskeyBrowser,
  passkeyFailure,
  passkeyLine,
  type Session,
  signIn,
  signInWithPasskey,
} from './passkeys'
import { CursorMenu, DialogueBox, Frame, PixelButton } from './ui/pixel'

type Mode = 'menu' | 'older' | 'found' | 'about'

const ABOUT = [
  'A passkey is a sign-in kept on your device and unlocked with your fingerprint, face or screen lock.',
  'There is no password to remember or leak. Your device offers the passkey when you choose Continue.',
]

/**
 * The title menu: ▶ Continue (a usernameless passkey sign-in), New guild (while founding is open),
 * Older passkey (sign in to a named guild, for passkeys made before resident keys were required)
 * and About passkeys (a Member explains in a dialogue box). Every failure is one in-world line,
 * told apart by `passkeyFailure`.
 */
export function SignInPanel({
  fetcher,
  browser,
  founding = 'closed',
  onSession,
}: {
  fetcher: Fetcher
  browser: PasskeyBrowser
  founding?: FoundingState
  onSession: (session: Session) => void
}) {
  const guildInput = useId()
  const [mode, setMode] = useState<Mode>('menu')
  const [guildId, setGuildId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<Session>) {
    setBusy(true)
    setError('')
    try {
      onSession(await action())
    } catch (caught) {
      setError(passkeyLine(passkeyFailure(caught), 'sign-in'))
    } finally {
      setBusy(false)
    }
  }

  function back() {
    setError('')
    setMode('menu')
  }

  function choose(id: string) {
    if (busy) {
      return
    }
    if (id === 'continue') {
      run(() => signInWithPasskey(fetcher, browser))
    } else if (id === 'new') {
      setError('')
      setMode('found')
    } else if (id === 'older') {
      setError('')
      setMode('older')
    } else if (id === 'about') {
      setError('')
      setMode('about')
    }
  }

  const olderField = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (mode === 'older') {
      olderField.current?.focus()
    }
  }, [mode])

  const guild = guildId.trim()
  const items = [
    { id: 'continue', label: 'Continue' },
    ...(founding === 'closed' ? [] : [{ id: 'new', label: 'New guild' }]),
    { id: 'older', label: 'Older passkey' },
    { id: 'about', label: 'About passkeys' },
  ]

  if (mode === 'about') {
    return <DialogueBox speaker="Member" lines={ABOUT} onDone={back} />
  }

  if (mode === 'found') {
    return (
      <Frame variant="dialog" className="title-panel">
        {founding === 'busy' ? (
          <p role="status" className="title-line">
            Founding is busy right now: try again shortly.
          </p>
        ) : (
          <FoundGuildPanel fetcher={fetcher} browser={browser} onSession={onSession} />
        )}
        <div className="title-actions">
          <PixelButton onClick={back}>Back</PixelButton>
        </div>
      </Frame>
    )
  }

  if (mode === 'older') {
    return (
      <Frame variant="dialog" className="title-panel">
        <div className="title-form">
          <label htmlFor={guildInput}>Guild id</label>
          <input
            ref={olderField}
            id={guildInput}
            name="guild-id"
            className="mono"
            autoComplete="off"
            value={guildId}
            onChange={(event) => setGuildId(event.target.value)}
          />
          <div className="title-actions">
            <PixelButton
              disabled={busy || !guild}
              onClick={() => run(() => signIn(guild, fetcher, browser))}
            >
              Sign in with a guild id
            </PixelButton>
            <PixelButton onClick={back}>Back</PixelButton>
          </div>
          <p role="alert" className="title-line">
            {error}
          </p>
        </div>
      </Frame>
    )
  }

  return (
    <Frame variant="dialog" className="title-panel">
      <div className="title-menu">
        <CursorMenu label="Title menu" items={items} onSelect={choose} autoFocus />
      </div>
      <p role="alert" className="title-line">
        {error}
      </p>
    </Frame>
  )
}
