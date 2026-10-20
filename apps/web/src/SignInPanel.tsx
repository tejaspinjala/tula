import { useState } from 'react'
import type { Fetcher } from './artifacts'
import {
  type PasskeyBrowser,
  PasskeyRequestError,
  type Session,
  signIn,
  signInWithPasskey,
} from './passkeys'

/** The words shown for a refused or abandoned sign-in. */
function describe(error: unknown): string {
  if (error instanceof PasskeyRequestError && error.status === 429) {
    return 'Too many attempts. Wait a minute, then try again.'
  }
  if (error instanceof Error && error.name === 'NotAllowedError') {
    return 'Sign-in was cancelled. Try again when you are ready.'
  }
  return 'The Guild Master could not be signed in with that passkey.'
}

/**
 * The signed-out entry: one primary "Sign in with passkey" button that needs no guild id (the
 * browser offers the discoverable passkey), and a small fallback that signs in to a named guild for
 * passkeys registered before resident keys were required.
 */
export function SignInPanel({
  fetcher,
  browser,
  onSession,
}: {
  fetcher: Fetcher
  browser: PasskeyBrowser
  onSession: (session: Session) => void
}) {
  const [guildId, setGuildId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function run(action: () => Promise<Session>) {
    setBusy(true)
    setError('')
    try {
      onSession(await action())
    } catch (caught) {
      setError(describe(caught))
    } finally {
      setBusy(false)
    }
  }

  const guild = guildId.trim()
  return (
    <section aria-labelledby="sign-in-heading" className="mt-8">
      <h2 id="sign-in-heading" className="text-xl font-semibold">
        Sign in
      </h2>
      <div className="mt-4 flex flex-col gap-2">
        <button
          type="button"
          className="rounded bg-black p-2 text-white"
          disabled={busy}
          onClick={() => run(() => signInWithPasskey(fetcher, browser))}
        >
          Sign in with passkey
        </button>
        <details className="mt-2">
          <summary>Older passkey? Use a guild id</summary>
          <div className="mt-2 flex flex-col gap-2">
            <label htmlFor="sign-in-guild-id">Guild id</label>
            <input
              id="sign-in-guild-id"
              name="guild-id"
              className="rounded border p-2 font-mono"
              value={guildId}
              onChange={(event) => setGuildId(event.target.value)}
            />
            <button
              type="button"
              className="rounded border p-2"
              disabled={busy || !guild}
              onClick={() => run(() => signIn(guild, fetcher, browser))}
            >
              Sign in with a guild id
            </button>
          </div>
        </details>
        <p role="alert">{error}</p>
      </div>
    </section>
  )
}
