import { useEffect, useState } from 'react'
import { type CostGroup, type CostRow, formatDollars, loadCosts } from './costs'
import type { Session } from './passkeys'

const GROUPS: Array<{ value: CostGroup; label: string }> = [
  { value: 'day', label: 'Day' },
  { value: 'hall', label: 'Hall' },
  { value: 'quest', label: 'Quest' },
  { value: 'run', label: 'Run' },
]

/** The cost table in the ledger view: tokens and dollars per day, Hall, Quest or run. */
export function CostTablePanel({ session }: { session: Session | null }) {
  const [by, setBy] = useState<CostGroup>('day')
  const [rows, setRows] = useState<CostRow[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!session) {
      setRows(null)
      return
    }
    setFailed(false)
    loadCosts(session, by, fetch)
      .then(setRows)
      .catch(() => setFailed(true))
  }, [session, by])

  return (
    <section aria-labelledby="costs-heading" className="mt-8">
      <h2 id="costs-heading" className="text-xl font-semibold">
        Costs
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see spend.</p>}
      {failed && <p role="alert">The cost table could not be loaded.</p>}
      {session && (
        <label className="mt-4 block">
          Group by{' '}
          <select
            value={by}
            onChange={(e) => setBy(GROUPS.find((g) => g.value === e.target.value)?.value ?? 'day')}
          >
            {GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {rows && (
        <table className="mt-2 w-full text-left">
          <caption className="sr-only">Spend by {by}</caption>
          <thead>
            <tr>
              <th scope="col">{GROUPS.find((g) => g.value === by)?.label}</th>
              <th scope="col">Calls</th>
              <th scope="col">Tokens in</th>
              <th scope="col">Tokens out</th>
              <th scope="col">Dollars</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th scope="row">{r.key}</th>
                <td>{r.calls}</td>
                <td>{r.inputTokens}</td>
                <td>{r.outputTokens}</td>
                <td>{formatDollars(r.costMicros)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
