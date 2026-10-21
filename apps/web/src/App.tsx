import { useEffect, useRef, useState } from 'react'
import { DesktopReturn } from './DesktopReturn'
import {
  desktopCodeFromHash,
  desktopRequested,
  enrolTokenFromHash,
  exchangeDesktopCode,
  type FoundingState,
  fetchGuild,
  foundingOpen,
  isDesktopShell,
  type PasskeyBrowser,
  restoreSession,
  type Session,
  takeDesktopCode,
  takeEnrolToken,
  webAuthnBrowser,
} from './passkeys'
import { Shell } from './Shell'
import { SignInPanel } from './SignInPanel'
import { TitleScene } from './TitleScene'

/** How long the title-to-world fade stays mounted: the 0.6 s CSS animation plus a frame. */
const FADE_MS = 700

const DESKTOP_CODE_LOST =
  'That hand-back ran out or was already used. Choose Sign in with your browser to try again.'

/**
 * The ledger: signed out it shows only sign-in (and founding while it is open); signed in it
 * shows the shell with one routed view at a time.
 */
export function App({ browser = webAuthnBrowser }: { browser?: PasskeyBrowser } = {}) {
  const desktopShell = isDesktopShell(navigator.userAgent)
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')
  const [session, setSession] = useState<Session | null>(null)
  const [restored, setRestored] = useState(false)
  // A one-time enrolment link carries its token in the fragment; it is read once and cleared.
  const [enrolToken, setEnrolToken] = useState(() => enrolTokenFromHash(window.location.hash))
  useEffect(() => {
    takeEnrolToken(window)
  }, [])
  // The link is single use: once any session opens, the title never offers it again.
  useEffect(() => {
    if (session) {
      setEnrolToken(null)
    }
  }, [session])

  // Inside the desktop shell the deep link delivers a one-time code in the fragment: it is read and
  // cleared once, then exchanged for a session. The shell only changes the fragment when the page
  // is already open, so the code is also taken on `hashchange`. `spent` keeps StrictMode (and a
  // repeated event) from exchanging one code twice.
  const [desktopCode] = useState(() => desktopCodeFromHash(window.location.hash))
  const [exchanging, setExchanging] = useState(desktopCode !== null)
  const [notice, setNotice] = useState('')
  const spent = useRef(new Set<string>())
  useEffect(() => {
    function exchange(code: string) {
      if (spent.current.has(code)) {
        return
      }
      spent.current.add(code)
      setExchanging(true)
      exchangeDesktopCode(code, fetch)
        .then((opened) => setSession((current) => current ?? opened))
        .catch(() => setNotice(DESKTOP_CODE_LOST))
        .finally(() => setExchanging(false))
    }
    function arrived() {
      const code = takeDesktopCode(window)
      if (code) {
        exchange(code)
      }
    }
    if (desktopCode) {
      takeDesktopCode(window)
      exchange(desktopCode)
    }
    window.addEventListener('hashchange', arrived)
    return () => window.removeEventListener('hashchange', arrived)
  }, [desktopCode])

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

  if (!session && (!restored || exchanging)) {
    return <p role="status">Checking your session...</p>
  }

  if (session && !desktopShell && desktopRequested(window.location.search)) {
    return (
      <TitleScene>
        <header>
          <h1 className="title-wordmark">Guildhall</h1>
        </header>
        <main id="main" tabIndex={-1}>
          <DesktopReturn fetcher={fetch} navigate={(url) => window.location.assign(url)} />
        </main>
      </TitleScene>
    )
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
            enrolToken={enrolToken}
            desktopShell={desktopShell}
            openInBrowser={() => window.open('/?desktop=1', '_blank')}
            notice={notice}
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
