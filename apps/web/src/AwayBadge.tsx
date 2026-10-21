import { useEffect, useRef, useState } from 'react'
import { Badge } from './Badge'
import type { Session } from './passkeys'
import { loadPresence, type Presence, returnHome } from './presence'
import { PixelButton } from './ui/pixel'

/** Props of {@link AwayBadge}. */
export interface AwayBadgeProps {
  session: Session
  /** Changes whenever the badge should read presence again (the Bag closed). */
  refresh: number
}

/**
 * The away badge for the HUD: nothing while the Guild Master is here; while away, an "Away"
 * badge with a one-tap "I'm back". A failed read shows nothing and leaves the HUD standing.
 */
export function AwayBadge({ session, refresh }: AwayBadgeProps) {
  const [presence, setPresence] = useState<Presence | null>(null)
  const [failed, setFailed] = useState(false)
  const lastRead = useRef(refresh)

  // Each new `refresh` value (the Bag closed) re-reads presence at once.
  useEffect(() => {
    let live = true
    lastRead.current = refresh
    loadPresence(session, fetch)
      .then((next) => live && setPresence(next))
      .catch(() => live && setPresence(null))
    return () => {
      live = false
    }
  }, [session, refresh])

  if (!presence?.away) {
    return null
  }
  const back = () => {
    setFailed(false)
    returnHome(session, fetch)
      .then(setPresence)
      .catch(() => setFailed(true))
  }
  return (
    <div className="hud-away">
      <Badge tone="info">Away</Badge>
      <PixelButton onClick={back}>I'm back</PixelButton>
      {failed && <p role="alert">Could not return. Try again.</p>}
    </div>
  )
}
