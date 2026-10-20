import { useState } from 'react'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { PixelButton } from './ui/pixel'
import { checkSecrets, listSecrets, type SecretCheck, submitSecret } from './vault'
import { WorkSection } from './WorkSection'

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
    <WorkSection id="vault" title="Vault">
      {session ? (
        <form
          className="work-body"
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
          <div className="work-actions">
            <PixelButton type="submit" disabled={!ref.trim() || !value}>
              Add secret
            </PixelButton>
            <PixelButton onClick={() => run('Refresh', refresh)}>Refresh</PixelButton>
          </div>
          <ul aria-label="Secret references" className="work-log">
            {secrets.map((secret) => (
              <li key={secret.ref} className="mono">
                {secret.ref}: {secret.status}
              </li>
            ))}
          </ul>
          <p role="status" aria-live="polite">
            {message}
          </p>
        </form>
      ) : (
        <p>Sign in with a passkey to use the Vault.</p>
      )}
    </WorkSection>
  )
}
