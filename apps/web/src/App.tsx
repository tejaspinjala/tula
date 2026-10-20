import { useEffect, useRef, useState } from 'react'
import {
  type FoundingState,
  fetchGuild,
  foundingOpen,
  type PasskeyBrowser,
  restoreSession,
  type Session,
  webAuthnBrowser,
} from './passkeys'
import { Shell } from './Shell'
import { SignInPanel } from './SignInPanel'
import { TitleScene } from './TitleScene'

/** How long the title-to-world fade stays mounted: the 0.6 s CSS animation plus a frame. */
const FADE_MS = 700

/**
 * The ledger: signed out it shows only sign-in (and founding while it is open); signed in it
 * shows the shell with one routed view at a time.
 */
export function App({ browser = webAuthnBrowser }: { browser?: PasskeyBrowser } = {}) {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')
  const [session, setSession] = useState<Session | null>(null)
  const [restored, setRestored] = useState(false)

  const [founding, setFounding] = useState<FoundingState>('closed')
  const [guild, setGuild] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
    foundingOpen(fetch).then(setFounding)
  }, [])

  useEffect(() => {
    restoreSession(fetch).then((found) => {
      setSession((current) => current ?? found)
      setRestored(true)
    })
  }, [])

  // The title dissolves into the world: a decorative overlay that fades out in steps, then goes.
  const onTitle = useRef(false)
  const [fading, setFading] = useState(false)
  useEffect(() => {
    if (!session) {
      onTitle.current = restored
      return
    }
    if (!onTitle.current) {
      return
    }
    onTitle.current = false
    setFading(true)
    const timer = setTimeout(() => setFading(false), FADE_MS)
    return () => clearTimeout(timer)
  }, [session, restored])

  useEffect(() => {
    setGuild(null)
    if (session) {
      fetchGuild(session, fetch)
        .then(setGuild)
        .catch(() => setGuild({ id: session.guildId, name: '' }))
    }
  }, [session])

  if (!session && !restored) {
    return <p role="status">Checking your session...</p>
  }

  if (!session) {
    return (
      <TitleScene>
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header>
          <h1 className="title-wordmark">Guildhall</h1>
          <p className="title-tagline">A guild of AI agents awaits its Guild Master</p>
        </header>
        <main id="main" tabIndex={-1}>
          {status === 'down' && (
            <p role="alert" className="title-line">
              guildd: down. The server is not answering.
            </p>
          )}
          <SignInPanel
            fetcher={fetch}
            browser={browser}
            founding={founding}
            onSession={setSession}
          />
        </main>
      </TitleScene>
    )
  }

  return (
    <>
      <Shell
        session={session}
        guildName={guild?.name ?? ''}
        status={status}
        onSession={setSession}
      />
      {fading && <div className="scene-fade" aria-hidden="true" />}
    </>
  )
}
