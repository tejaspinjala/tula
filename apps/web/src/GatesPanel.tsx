import { useCallback, useEffect, useState } from 'react'
import { barGates, describeGates, type GatesStatus, liftGates, loadGates } from './gates'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'

/**
 * Bar the Gates: the Guild Master's kill switch for this guild or every guild. Barring is one
 * press; lifting asks for the passkey again, because it lets work resume.
 */
export function GatesPanel({ session }: { session: Session | null }) {
  const [status, setStatus] = useState<GatesStatus | null>(null)
  const [message, setMessage] = useState('')

  const refresh = useCallback(() => {
    if (!session) {
      setStatus(null)
      return
    }
    loadGates(session, fetch)
      .then(setStatus)
      .catch(() => setMessage('The Gates status could not be loaded.'))
  }, [session])

  useEffect(refresh, [refresh])

  async function run(action: (current: Session) => Promise<string>) {
    if (!session) {
      return
    }
    try {
      setMessage(await action(session))
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The request failed.')
    }
    refresh()
  }

  return (
    <section aria-labelledby="gates-heading" className="mt-8">
      <h2 id="gates-heading" className="text-xl font-semibold">
        Bar the Gates
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to use the Gates.</p>}
      {status && (
        <p className="mt-4" role={status.guild || status.global ? 'alert' : 'status'}>
          {describeGates(status)}
        </p>
      )}
      {session && (
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() =>
              run(async (current) => {
                const done = await barGates(current, 'guild', fetch)
                return `Barred: ${done.revokedRuns} run tokens revoked, ${done.killedSandboxes} sandboxes stopped.`
              })
            }
          >
            Bar this guild
          </button>
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() =>
              run(async (current) => {
                const done = await barGates(current, 'global', fetch)
                return `Barred every guild: ${done.revokedRuns} run tokens revoked, ${done.killedSandboxes} sandboxes stopped.`
              })
            }
          >
            Bar every guild
          </button>
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() =>
              run(async (current) => {
                await liftGates(current, 'guild', fetch, webAuthnBrowser)
                return 'The guild bar is lifted.'
              })
            }
          >
            Lift this guild's bar with passkey
          </button>
          <button
            type="button"
            className="min-h-11 rounded border p-2"
            onClick={() =>
              run(async (current) => {
                await liftGates(current, 'global', fetch, webAuthnBrowser)
                return 'The global bar is lifted.'
              })
            }
          >
            Lift the global bar with passkey
          </button>
        </div>
      )}
      {message && (
        <p className="mt-4" role="status">
          {message}
        </p>
      )}
    </section>
  )
}
