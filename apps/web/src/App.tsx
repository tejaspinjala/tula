import { useEffect, useState } from 'react'
import { FoundGuildPanel } from './FoundGuildPanel'
import {
  fetchGuild,
  foundingOpen,
  type PasskeyBrowser,
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

  const [open, setOpen] = useState(false)
  const [guild, setGuild] = useState<{ id: string; name: string } | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
    foundingOpen(fetch).then(setOpen)
  }, [])

  useEffect(() => {
    setGuild(null)
    if (session) {
      fetchGuild(session, fetch)
        .then(setGuild)
        .catch(() => setGuild({ id: session.guildId, name: '' }))
    }
  }, [session])

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
          <p className="muted">guildd: {status}</p>
          <SignInPanel fetcher={fetch} browser={browser} onSession={setSession} />
          {open && <FoundGuildPanel fetcher={fetch} browser={browser} onSession={setSession} />}
        </main>
      </div>
    )
  }

  return (
    <Shell session={session} guildName={guild?.name ?? ''} status={status} onSession={setSession} />
  )
}
