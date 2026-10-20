import { useState } from 'react'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { checkSecrets, listSecrets, type SecretCheck, submitSecret } from './vault'

/** The Vault screen: add a provider key once (after re-authentication) and see which refs resolve. */
export function VaultPanel({ session }: { session: Session | null }) {
  const [ref, setRef] = useState('')
  const [value, setValue] = useState('')
  const [message, setMessage] = useState('')
  const [secrets, setSecrets] = useState<SecretCheck[]>([])

  async function refresh(current: Session) {
    const page = await listSecrets(current, fetch)
    setSecrets(page.refs.length > 0 ? await checkSecrets(current, page.refs, fetch) : [])
  }

  async function run(label: string, action: (current: Session) => Promise<void>) {
    if (!session) {
      return
    }
    setMessage(`${label}...`)
    try {
      await action(session)
      setMessage(`${label}: done`)
    } catch (error) {
      setMessage(
        error instanceof PasskeyRequestError ? `${label} refused: ${error.code}` : `${label} failed`
      )
    }
  }

  return (
    <section aria-labelledby="vault-heading" className="card">
      <h2 id="vault-heading" className="card-title">
        Vault
      </h2>
      {session ? (
        <form
          className="mt-4 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            run('Add secret', async (current) => {
              // The value is never shown again: cleared once sent, even if the add fails.
              await submitSecret(current, ref.trim(), value, fetch, webAuthnBrowser, () =>
                setValue('')
              )
              await refresh(current)
            })
          }}
        >
          <label htmlFor="vault-ref">Secret reference</label>
          <input
            id="vault-ref"
            className="mono"
            value={ref}
            onChange={(event) => setRef(event.target.value)}
          />
          <label htmlFor="vault-value">Provider key</label>
          <input
            id="vault-value"
            type="password"
            autoComplete="off"
            className="mono"
            value={value}
            onChange={(event) => setValue(event.target.value)}
          />
          <div className="flex gap-2">
            <button type="submit" className="btn-primary" disabled={!ref.trim() || !value}>
              Add secret
            </button>
            <button type="button" onClick={() => run('Refresh', refresh)}>
              Refresh
            </button>
          </div>
          <ul aria-label="Secret references">
            {secrets.map((secret) => (
              <li key={secret.ref} className="font-mono">
                {secret.ref}: {secret.status}
              </li>
            ))}
          </ul>
          <p role="status" aria-live="polite">
            {message}
          </p>
        </form>
      ) : (
        <p className="mt-4">Sign in with a passkey to use the Vault.</p>
      )}
    </section>
  )
}
