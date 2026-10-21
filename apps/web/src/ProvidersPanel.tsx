import { useCallback, useEffect, useState } from 'react'
import { loadCurrent } from './builder/api'
import { type PasskeyBrowser, PasskeyRequestError, type Session, webAuthnBrowser } from './passkeys'
import {
  type Deployment,
  describePrivateDestination,
  loadProviderStatus,
  type ProviderRow,
  providersOf,
  setProviderPrivate,
} from './providers'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * Settings > Providers: each provider's private-eligible state and where Private Quests would go
 * through it. Turning it on asks for the passkey again (a widening change); turning it off applies
 * at once. The disclosure comes from the server: whether subscriptions run here and which vendor is called.
 */
export function ProvidersPanel({
  session,
  browser = webAuthnBrowser,
}: {
  session: Session
  browser?: PasskeyBrowser
}) {
  const [rows, setRows] = useState<ProviderRow[] | null>(null)
  const [where, setWhere] = useState<Deployment | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(() => {
    Promise.all([loadCurrent(session, fetch), loadProviderStatus(session, fetch)])
      .then(([current, status]) => {
        setRows(providersOf(current.config))
        setWhere(status)
      })
      .catch(() => setMessage('Your providers could not be loaded.'))
  }, [session])

  useEffect(refresh, [refresh])

  async function change(row: ProviderRow, on: boolean) {
    setBusy(true)
    try {
      const done = await setProviderPrivate(session, row.id, on, fetch, browser)
      setMessage(
        done === 'confirmed'
          ? `${row.id} may now serve Private Quests.`
          : `${row.id} no longer serves Private Quests.`
      )
    } catch (e) {
      setMessage(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The change failed.')
    }
    setBusy(false)
    refresh()
  }

  return (
    <WorkSection id="providers" title="Providers">
      {(rows === null || where === null) && !message && <p role="status">Loading.</p>}
      {rows?.length === 0 && <p>No provider is configured yet.</p>}
      {rows && where && rows.length > 0 && (
        <ul className="provider-list">
          {rows.map((row) => (
            <li key={row.id} className="work-note provider-row">
              <p className="provider-name">
                {row.id}{' '}
                <span className="provider-state">
                  {row.privateEligible ? '✓ Private-eligible' : '○ Not private-eligible'}
                </span>
              </p>
              <p>{describePrivateDestination(row, where)}</p>
              <div className="work-actions">
                <PixelButton
                  disabled={busy}
                  onClick={() => change(row, !row.privateEligible)}
                  aria-label={`${row.privateEligible ? 'Stop private work on' : 'Allow private work on'} ${row.id}`}
                >
                  {row.privateEligible ? 'Turn off' : 'Allow private work'}
                </PixelButton>
              </div>
            </li>
          ))}
        </ul>
      )}
      {message && <p role="status">{message}</p>}
    </WorkSection>
  )
}
