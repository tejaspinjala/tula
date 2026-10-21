import { useCallback, useEffect, useState } from 'react'
import { Badge } from './Badge'
import type { Session } from './passkeys'
import { loadPresence, type Presence, returnHome } from './presence'
import { PixelButton } from './ui/pixel'

/** Props of {@link AwayBadge}. */
export interface AwayBadgeProps {
  session: Session
}

/**
 * The away badge for the HUD: nothing while the Guild Master is here; while away, an "Away"
 * badge with a one-tap "I'm back". A failed read shows nothing and leaves the HUD standing.
 */
export function AwayBadge({ session }: AwayBadgeProps) {
  const [presence, setPresence] = useState<Presence | null>(null)
  const [failed, setFailed] = useState(false)
  const until = presence?.until ?? null

  const reload = useCallback(() => {
    loadPresence(session, fetch)
      .then(setPresence)
      .catch(() => setPresence(null))
  }, [session])

  // The HUD remounts the badge with a new key when the Bag closes, which reads presence again.
  useEffect(reload, [reload])

  // When the return time passes, read again so the badge clears itself.
  useEffect(() => {
    if (until === null) {
      return
    }
    const wait = Math.min(new Date(until).getTime() - Date.now() + 1000, 2_147_000_000)
    const id = setTimeout(reload, Math.max(wait, 1000))
    return () => clearTimeout(id)
  }, [until, reload])

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
