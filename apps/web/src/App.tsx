import { useEffect, useState } from 'react'
import { FoundGuildPanel } from './FoundGuildPanel'
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
      <div className="signed-out">
        <a href="#main" className="skip-link">
          Skip to content
        </a>
        <header className="shell-header">
          <h1 className="brand">Guildhall ledger</h1>
        </header>
        <main id="main" tabIndex={-1} className="signed-out-main">
          <section aria-labelledby="about-heading" className="card">
            <h2 id="about-heading" className="card-title">
              What is Guildhall?
            </h2>
            <p className="mt-2">
              Guildhall is where you run a guild of AI agents. They do the work as Quests, and
              anything that touches the outside world waits for your Seal.
            </p>
            <details className="disclosure">
              <summary>What is a passkey?</summary>
              <p>
                A passkey is a sign-in kept on your device and unlocked with your fingerprint, face
                or screen lock. There is no password to remember or leak.
              </p>
            </details>
          </section>
          {status === 'down' && (
            <p role="alert" className="mt-4">
              guildd: down. The server is not answering.
            </p>
          )}
          <SignInPanel fetcher={fetch} browser={browser} onSession={setSession} />
          {founding === 'open' && (
            <FoundGuildPanel fetcher={fetch} browser={browser} onSession={setSession} />
          )}
          {founding === 'busy' && (
            <section aria-labelledby="found-busy-heading" className="card">
              <h2 id="found-busy-heading" className="card-title">
                Found your guild
              </h2>
              <p role="status" className="mt-2">
                Founding is busy right now: try again shortly.
              </p>
            </section>
          )}
        </main>
      </div>
    )
  }

  return (
    <Shell session={session} guildName={guild?.name ?? ''} status={status} onSession={setSession} />
  )
}
