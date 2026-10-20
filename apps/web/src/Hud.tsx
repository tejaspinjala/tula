import { useEffect, useRef, useState } from 'react'
import type { Session } from './passkeys'
import { listSeals } from './seals'
import { formatCents, loadTreasuryOverview, type TreasuryView } from './treasury'
import { Frame, Meter, PixelButton } from './ui/pixel'

/** How often the HUD reads its numbers again while the Guild Master walks. */
const POLL_MS = 30_000

/** Props of {@link Hud}. */
export interface HudProps {
  session: Session
  guildName: string
  status: 'checking' | 'ok' | 'down'
  /** Changes whenever the HUD should read its numbers again (the Bag closed). */
  refresh: number
  onOpenBag: () => void
  onOpenSeals: () => void
}

/**
 * The heads-up display over the world: the guild name plate (the page heading), the day, a
 * Treasury Meter of what is left to spend today, a Seal count badge and the Bag button. A failed
 * read hides that figure and leaves the rest standing.
 */
export function Hud({ session, guildName, status, refresh, onOpenBag, onOpenSeals }: HudProps) {
  const [treasury, setTreasury] = useState<TreasuryView['overview'] | null>(null)
  const [waiting, setWaiting] = useState<{ count: number; more: boolean } | null>(null)

  // Each new `refresh` value (the Bag closed) re-reads the figures at once.
  const lastRead = useRef(refresh)
  useEffect(() => {
    let live = true
    lastRead.current = refresh
    const read = () => {
      loadTreasuryOverview(session, fetch)
        .then((overview) => live && setTreasury(overview))
        .catch(() => live && setTreasury(null))
      listSeals(session, fetch, 50)
        .then((page) => live && setWaiting({ count: page.seals.length, more: page.next !== null }))
        .catch(() => live && setWaiting(null))
    }
    read()
    const id = setInterval(read, POLL_MS)
    return () => {
      live = false
      clearInterval(id)
    }
  }, [session, refresh])

  const cap = treasury ? treasury.limits.dailyCapCents : 0
  const left = treasury ? treasury.limits.dailyCapCents - treasury.spentTodayCents : 0
  const sealLabel =
    waiting === null ? 'Seals' : `Seals ${waiting.count}${waiting.more ? '+' : ''} waiting`

  return (
    <header className="hud">
      <Frame variant="wood">
        <div className="hud-row">
          <h1 className="hud-plate">{guildName || 'Guildhall'}</h1>
          {treasury && <p className="hud-day">Day {treasury.day}</p>}
          {treasury && (
            <Meter label="Treasury left today" value={left} max={cap} format={formatCents} />
          )}
          <PixelButton aria-label={sealLabel} onClick={onOpenSeals} className="hud-seals">
            Seals{waiting ? ` ${waiting.count}${waiting.more ? '+' : ''}` : ''}
          </PixelButton>
          {status === 'down' && (
            <p role="alert" className="hud-alert">
              guildd: down
            </p>
          )}
          <PixelButton onClick={onOpenBag} className="hud-bag">
            Bag (B)
          </PixelButton>
        </div>
      </Frame>
    </header>
  )
}
