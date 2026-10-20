import { useCallback, useEffect, useState } from 'react'
import type { Session } from './passkeys'
import { describeEntry, formatCents, loadTreasury, type TreasuryView } from './treasury'
import { Frame, Meter, PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

/**
 * The Treasury screen: paper balances, today's spend against the daily cap, every ledger entry and
 * whether the ledger's hash chain still verifies. Read-only: balances move only through the
 * guild's deterministic rules, never from this screen or any agent.
 */
export function TreasuryPanel({ session }: { session: Session | null }) {
  const [view, setView] = useState<TreasuryView | null>(null)
  const [failed, setFailed] = useState(false)

  const refresh = useCallback(() => {
    if (!session) {
      setView(null)
      return
    }
    loadTreasury(session, fetch)
      .then((loaded) => {
        setView(loaded)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [session])

  useEffect(refresh, [refresh])

  return (
    <WorkSection id="treasury" title="Treasury">
      {!session && <p>Sign in with a passkey to see the Treasury.</p>}
      {failed && <p role="alert">The Treasury could not be loaded.</p>}
      {view && (
        <div className="work-body">
          <p>Paper money only: no real payment is ever made.</p>
          <Frame variant="wood">
            <dl aria-label="Balances" className="work-stat">
              <dt>Operating</dt>
              <dd>{formatCents(view.overview.balances.operating)}</dd>
              <dt>Reserve (released only by the Guild Master)</dt>
              <dd>{formatCents(view.overview.balances.reserve)}</dd>
              <dt>Profit</dt>
              <dd>{formatCents(view.overview.balances.profit)}</dd>
              <dt>Spent today</dt>
              <dd>
                {formatCents(view.overview.spentTodayCents)} of{' '}
                {formatCents(view.overview.limits.dailyCapCents)}
              </dd>
            </dl>
            <Meter
              label="Left today"
              value={Math.max(
                0,
                Math.round(
                  (view.overview.limits.dailyCapCents - view.overview.spentTodayCents) / 100
                )
              )}
              max={Math.round(view.overview.limits.dailyCapCents / 100)}
            />
          </Frame>
          {view.chain.intact ? (
            <p>Ledger chain verified: {view.chain.entries} entries.</p>
          ) : (
            <p role="alert">
              Ledger chain broken at entry #{view.chain.firstBadSeq}: {view.chain.reason}.
            </p>
          )}
          <ul aria-label="Ledger entries" className="work-log">
            {view.entries.map((entry) => (
              <li key={entry.seq}>{describeEntry(entry)}</li>
            ))}
          </ul>
        </div>
      )}
      {session && <PixelButton onClick={refresh}>Refresh Treasury</PixelButton>}
    </WorkSection>
  )
}
