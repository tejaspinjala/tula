import { useCallback, useEffect, useState } from 'react'
import type { Session } from './passkeys'
import { describePause, type HallPauseView, loadTripwires } from './tripwires'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * The Tripwire indicator in the ledger view: a visible problem for every paused Hall, with the
 * Tripwire that paused it. Resuming a Hall is a re-authenticated Guild Master action.
 */
export function TripwirePanel({ session }: { session: Session | null }) {
  const [pauses, setPauses] = useState<HallPauseView[]>([])
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    if (!session) {
      setPauses([])
      return
    }
    loadTripwires(session, fetch)
      .then((loaded) => {
        setPauses(loaded.pauses)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [session])

  useEffect(refresh, [refresh])

  return (
    <WorkSection id="tripwires" title="Tripwires">
      {!session && <p>Sign in with a passkey to see Hall pauses.</p>}
      {failed && <p role="alert">Hall pauses could not be loaded.</p>}
      {session && pauses.length === 0 && !failed && <p>No Hall is paused.</p>}
      {pauses.length > 0 && (
        <ul aria-label="Paused Halls" className="work-log" role="alert">
          {pauses.map((pause) => (
            <li key={pause.id}>{describePause(pause)}</li>
          ))}
        </ul>
      )}
      {session && <PixelButton onClick={refresh}>Refresh pauses</PixelButton>}
    </WorkSection>
  )
}
