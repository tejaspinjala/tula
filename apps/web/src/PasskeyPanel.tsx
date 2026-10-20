import { useState } from 'react'
import {
  PasskeyRequestError,
  reauthenticate,
  registerPasskey,
  type Session,
  signIn,
  webAuthnBrowser,
} from './passkeys'

/** Passkey registration, sign-in and re-authentication for one guild; every control is a real button or input. */
export function PasskeyPanel({
  session,
  onSession,
}: {
  session: Session | null
  onSession: (session: Session | null) => void
}) {
  const [guildId, setGuildId] = useState('')
  const [message, setMessage] = useState('')

  async function run(label: string, action: () => Promise<string | undefined>) {
    setMessage(`${label}...`)
    try {
      setMessage((await action()) ?? `${label}: done`)
    } catch (error) {
      setMessage(
        error instanceof PasskeyRequestError ? `${label} refused: ${error.code}` : `${label} failed`
      )
    }
  }

  const guild = guildId.trim()
  return (
    <section aria-labelledby="passkey-heading" className="card">
      <h2 id="passkey-heading" className="card-title">
        Passkey
      </h2>
      <div className="mt-4 flex flex-col gap-2">
        <label htmlFor="passkey-guild">Guild id</label>
        <input
          id="passkey-guild"
          className="mono"
          value={guildId}
          onChange={(event) => setGuildId(event.target.value)}
        />
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={!guild}
            onClick={() =>
              run('Register passkey', async () => {
                if (session) {
                  const proof = await reauthenticate(session.token, fetch, webAuthnBrowser)
                  await registerPasskey(
                    guild,
                    { token: session.token, proof },
                    fetch,
                    webAuthnBrowser
                  )
                } else {
                  await registerPasskey(guild, undefined, fetch, webAuthnBrowser)
                }
                return undefined
              })
            }
          >
            Register passkey
          </button>
          <button
            type="button"
            className="btn-primary"
            disabled={!guild}
            onClick={() =>
              run('Sign in', async () => {
                onSession(await signIn(guild, fetch, webAuthnBrowser))
                return 'Signed in'
              })
            }
          >
            Sign in
          </button>
          {session && (
            <button
              type="button"
              onClick={() => {
                onSession(null)
                setMessage('Signed out')
              }}
            >
              Sign out
            </button>
          )}
        </div>
        <p role="status" aria-live="polite">
          {session ? `Signed in to guild ${session.guildId}. ` : ''}
          {message}
        </p>
      </div>
    </section>
  )
}
