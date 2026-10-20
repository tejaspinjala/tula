import { useEffect, useState } from 'react'
import {
  type CostGroup,
  type CostPerPost,
  type CostRow,
  campaignLabel,
  costPerPostText,
  formatDollars,
  loadCostPerPost,
  loadCosts,
} from './costs'
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
  const [posts, setPosts] = useState<CostPerPost | null>(null)
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

  useEffect(() => {
    if (!session) {
      setPosts(null)
      return
    }
    loadCostPerPost(session, fetch)
      .then(setPosts)
      .catch(() => setFailed(true))
  }, [session])

  return (
    <section aria-labelledby="costs-heading" className="card">
      <h2 id="costs-heading" className="card-title">
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
        <div className="table-scroll">
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
        </div>
      )}
      {posts && (
        <>
          <h3 className="sub-title">Cost per accepted post</h3>
          <p className="mt-2">
            {posts.overall.posts === 0
              ? 'No post has been accepted yet.'
              : `${posts.overall.posts} accepted, ${costPerPostText(posts.overall)}${posts.overall.costMicros === 0 ? '' : ' each'}.`}
          </p>
          {posts.campaigns.length > 0 && (
            <div className="table-scroll">
              <table className="mt-2 w-full text-left">
                <caption className="sr-only">Cost per accepted post by Campaign</caption>
                <thead>
                  <tr>
                    <th scope="col">Campaign</th>
                    <th scope="col">Posts</th>
                    <th scope="col">Dollars</th>
                    <th scope="col">Per post</th>
                  </tr>
                </thead>
                <tbody>
                  {posts.campaigns.map((c) => (
                    <tr key={c.campaignId ?? 'none'}>
                      <th scope="row" title={c.campaignId ?? undefined}>
                        {campaignLabel(c.campaignId)}
                      </th>
                      <td>{c.posts}</td>
                      <td>{formatDollars(c.costMicros)}</td>
                      <td>{costPerPostText(c)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  )
}
