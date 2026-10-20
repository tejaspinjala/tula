import { useEffect, useState } from 'react'
import type { Session } from './passkeys'
import { loadRoster, type Roster } from './roster'

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
    <section aria-labelledby="roster-heading" className="card">
      <h2 id="roster-heading" className="card-title">
        Roster
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see the roster.</p>}
      {failed && <p role="alert">The roster could not be loaded.</p>}
      {roster && (
        <>
          <p className="mt-4">Steward: {roster.steward.name}</p>
          <ul aria-label="Halls" className="mt-2 flex flex-col gap-2">
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
    </section>
  )
}
