import { useEffect, useState } from 'react'
import { ArtifactViewer } from './ArtifactViewer'
import { PasskeyPanel } from './PasskeyPanel'
import type { Session } from './passkeys'

/** Ledger-view shell: keyboard-navigable, with a skip link, landmarks and passkey sign-in. */
export function App() {
  const [status, setStatus] = useState<'checking' | 'ok' | 'down'>('checking')
  const [session, setSession] = useState<Session | null>(null)

  useEffect(() => {
    fetch('/api/health')
      .then((res) => setStatus(res.ok ? 'ok' : 'down'))
      .catch(() => setStatus('down'))
  }, [])

  return (
    <>
      <a href="#main" className="absolute -translate-y-full bg-white p-2 focus:translate-y-0">
        Skip to content
      </a>
      <header className="mx-auto max-w-3xl px-8 pt-8">
        <h1 className="text-2xl font-semibold">Guildhall ledger</h1>
        <nav aria-label="Ledger" className="mt-2 flex gap-4">
          <a href="#passkey-heading">Passkey</a>
          <a href="#artifact-heading">Artifacts</a>
        </nav>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto max-w-3xl p-8">
        <p>guildd: {status}</p>
        <PasskeyPanel session={session} onSession={setSession} />
        <ArtifactViewer />
      </main>
    </>
  )
}
