import { useCallback, useEffect, useState } from 'react'
import type { Session } from './passkeys'
import { describeEntry, formatCents, loadTreasury, type TreasuryView } from './treasury'

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
    <section aria-labelledby="treasury-heading" className="card">
      <h2 id="treasury-heading" className="card-title">
        Treasury
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see the Treasury.</p>}
      {failed && <p role="alert">The Treasury could not be loaded.</p>}
      {view && (
        <>
          <p className="mt-4">Paper money only: no real payment is ever made.</p>
          <dl aria-label="Balances" className="mt-4 grid grid-cols-2 gap-2">
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
          {view.chain.intact ? (
            <p className="mt-4">Ledger chain verified: {view.chain.entries} entries.</p>
          ) : (
            <p role="alert" className="mt-4">
              Ledger chain broken at entry #{view.chain.firstBadSeq}: {view.chain.reason}.
            </p>
          )}
          <ul aria-label="Ledger entries" className="mt-4 flex flex-col gap-1">
            {view.entries.map((entry) => (
              <li key={entry.seq}>{describeEntry(entry)}</li>
            ))}
          </ul>
        </>
      )}
      {session && (
        <button type="button" className="mt-4" onClick={refresh}>
          Refresh Treasury
        </button>
      )}
    </section>
  )
}
