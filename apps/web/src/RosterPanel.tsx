import { useEffect, useState } from 'react'
import type { Session } from './passkeys'
import { loadRoster, type Roster } from './roster'
import { WorkSection } from './WorkSection'

/** The roster in the ledger view: the Steward and each Hall with its Captain and Members. */
export function RosterPanel({ session }: { session: Session | null }) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!session) {
      setRoster(null)
      return
    }
    setFailed(false)
    loadRoster(session, fetch)
      .then(setRoster)
      .catch(() => setFailed(true))
  }, [session])

  return (
    <WorkSection id="roster" title="Roster">
      {!session && <p>Sign in with a passkey to see the roster.</p>}
      {failed && <p role="alert">The roster could not be loaded.</p>}
      {roster && (
        <>
          <p>Steward: {roster.steward.name}</p>
          <ul aria-label="Halls" className="work-log">
            {roster.halls.map((hall) => (
              <li key={hall.id}>
                <strong>{hall.name}</strong>
                {hall.locked ? ' (locked)' : ''}
                {hall.captain && <div>Captain: {hall.captain.name}</div>}
                {hall.members.length > 0 && (
                  <ul aria-label={`${hall.name} Members`}>
                    {hall.members.map((m) => (
                      <li key={m.id}>
                        {m.name} ({m.rank})
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </WorkSection>
  )
}
