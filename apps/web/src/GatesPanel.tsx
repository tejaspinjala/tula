import { useCallback, useEffect, useState } from 'react'
import { barGates, describeGates, type GatesStatus, liftGates, loadGates } from './gates'
import { PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * Bar the Gates: the Guild Master's kill switch for this guild, and for every guild when the
 * Guild Master is also a platform operator. Barring is one
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
    <WorkSection id="gates" title="Bar the Gates">
      {!session && <p>Sign in with a passkey to use the Gates.</p>}
      {status && (
        <p role={status.guild || status.global ? 'alert' : 'status'}>{describeGates(status)}</p>
      )}
      {session && (
        <div className="work-actions">
          <PixelButton
            danger
            onClick={() =>
              run(async (current) => {
                const done = await barGates(current, 'guild', fetch)
                return `Barred: ${done.revokedRuns} run tokens revoked, ${done.killedSandboxes} sandboxes stopped.`
              })
            }
          >
            Bar this guild
          </PixelButton>
          <PixelButton
            onClick={() =>
              run(async (current) => {
                await liftGates(current, 'guild', fetch, webAuthnBrowser)
                return 'The guild bar is lifted.'
              })
            }
          >
            Lift this guild's bar with passkey
          </PixelButton>
          {status?.operator && (
            <>
              <PixelButton
                danger
                onClick={() =>
                  run(async (current) => {
                    const done = await barGates(current, 'global', fetch)
                    return `Barred every guild: ${done.revokedRuns} run tokens revoked, ${done.killedSandboxes} sandboxes stopped.`
                  })
                }
              >
                Bar every guild
              </PixelButton>
              <PixelButton
                onClick={() =>
                  run(async (current) => {
                    await liftGates(current, 'global', fetch, webAuthnBrowser)
                    return 'The global bar is lifted.'
                  })
                }
              >
                Lift the global bar with passkey
              </PixelButton>
            </>
          )}
        </div>
      )}
      {message && <p role="status">{message}</p>}
    </WorkSection>
  )
}
