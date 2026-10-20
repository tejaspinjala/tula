import { type ReactNode, useCallback, useEffect, useState } from 'react'
import { Badge, type Tone } from './Badge'
import { costPerPostText, loadCostPerPost } from './costs'
import { barGates, describeGates, loadGates } from './gates'
import { PasskeyRequestError, type Session } from './passkeys'
import { BOARD_STATES, groupByState, loadQuests } from './quests'
import { listSeals } from './seals'
import { describeSummon, loadSummon } from './summon'

type Loaded<T> = { state: 'loading' } | { state: 'error' } | { state: 'ok'; data: T }

function useLoaded<T>(
  session: Session,
  load: (session: Session) => Promise<T>
): Loaded<T> & { reload: () => void } {
  const [result, setResult] = useState<Loaded<T>>({ state: 'loading' })
  const [round, setRound] = useState(0)
  // The loader is a module-level function at every call site, so it is a stable dependency.
  // `round` re-runs the load (a reload keeps the old data on screen instead of flashing Loading).
  useEffect(() => {
    let live = true
    if (round === 0) {
      setResult({ state: 'loading' })
    }
    load(session)
      .then((data) => live && setResult({ state: 'ok', data }))
      .catch(() => live && setResult({ state: 'error' }))
    return () => {
      live = false
    }
  }, [session, load, round])
  const reload = useCallback(() => setRound((n) => n + 1), [])
  return { ...result, reload }
}

function Tile({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section aria-labelledby={id} className="card tile">
      <h2 id={id} className="tile-title">
        {title}
      </h2>
      {children}
    </section>
  )
}

function Waiting() {
  return <p className="muted">Loading...</p>
}

function Failed({ what }: { what: string }) {
  return (
    <p role="alert" className="error-text">
      {what} could not be loaded.
    </p>
  )
}

const loadWaitingSeals = (session: Session) => listSeals(session, fetch, 50)
const loadAllQuests = (session: Session) => loadQuests(session, fetch)
const loadSummonStatus = (session: Session) => loadSummon(session, fetch)
const loadCostPosts = (session: Session) => loadCostPerPost(session, fetch)
const loadGatesStatus = (session: Session) => loadGates(session, fetch)

/**
 * Home: what needs the Guild Master first. Seals awaiting the Guild Master, the Gates (with Bar
 * the Gates one press away), Summon status, the Quest Board at a glance and cost per accepted post.
 */
export function HomePanel({
  session,
  navigate,
}: {
  session: Session
  navigate: (path: string) => void
}) {
  const seals = useLoaded(session, loadWaitingSeals)
  const quests = useLoaded(session, loadAllQuests)
  const summon = useLoaded(session, loadSummonStatus)
  const posts = useLoaded(session, loadCostPosts)
  const gates = useLoaded(session, loadGatesStatus)
  const reloadGates = gates.reload
  const [barred, setBarred] = useState('')

  const bar = useCallback(async () => {
    try {
      const done = await barGates(session, 'guild', fetch)
      setBarred(
        `Barred: ${done.revokedRuns} run tokens revoked, ${done.killedSandboxes} sandboxes stopped.`
      )
      reloadGates()
    } catch (e) {
      setBarred(e instanceof PasskeyRequestError ? `Refused: ${e.code}` : 'The request failed.')
    }
  }, [session, reloadGates])

  const open = (path: string) => (event: { preventDefault: () => void }) => {
    event.preventDefault()
    navigate(path)
  }

  const waiting = seals.state === 'ok' ? seals.data.seals.length : 0
  const board = quests.state === 'ok' ? groupByState(quests.data) : null
  const gatesTone: Tone =
    gates.state === 'ok' && (gates.data.guild || gates.data.global) ? 'danger' : 'ok'

  return (
    <div>
      <p className="muted">What needs the Guild Master first.</p>
      <div className="tiles">
        <Tile id="home-seals" title="Seals awaiting the Guild Master">
          {seals.state === 'loading' && <Waiting />}
          {seals.state === 'error' && <Failed what="The Seals" />}
          {seals.state === 'ok' && (
            <>
              <p className="figure">
                <span
                  className={`count-badge${waiting === 0 ? ' count-badge-neutral' : ''}`}
                  role="img"
                  aria-label={`${waiting} waiting`}
                >
                  {waiting}
                  {seals.data.next ? '+' : ''}
                </span>
              </p>
              <p className="muted">
                {waiting === 0 ? 'No Seal is waiting.' : 'Each one needs your passkey.'}
              </p>
              <a href="/seals" className="btn btn-primary" onClick={open('/seals')}>
                Open the Seal inbox
              </a>
            </>
          )}
        </Tile>
        <Tile id="home-gates" title="The Gates">
          {gates.state === 'loading' && <Waiting />}
          {gates.state === 'error' && <Failed what="The Gates status" />}
          {gates.state === 'ok' && (
            <p>
              <Badge tone={gatesTone}>{describeGates(gates.data)}</Badge>
            </p>
          )}
          <div className="actions">
            <button type="button" className="btn btn-danger" onClick={bar}>
              Bar the Gates
            </button>
            <a href="/gates" className="btn" onClick={open('/gates')}>
              Gates settings
            </a>
          </div>
          {barred && <p role="status">{barred}</p>}
        </Tile>
        <Tile id="home-summon" title="Summon status">
          {summon.state === 'loading' && <Waiting />}
          {summon.state === 'error' && <Failed what="The Summon status" />}
          {summon.state === 'ok' && (
            <>
              <p>
                <Badge tone={summon.data.complete ? 'ok' : 'warn'}>
                  {summon.data.complete ? 'Summoned' : 'Not summoned yet'}
                </Badge>
              </p>
              <p className="muted">{describeSummon(summon.data)}</p>
            </>
          )}
          <a href="/roster" className="btn" onClick={open('/roster')}>
            Open Roster and Summon
          </a>
        </Tile>
        <Tile id="home-cost" title="Cost per accepted post">
          {posts.state === 'loading' && <Waiting />}
          {posts.state === 'error' && <Failed what="The cost per accepted post" />}
          {posts.state === 'ok' && (
            <>
              <p className="figure">
                {posts.data.overall.posts === 0 ? 'None yet' : costPerPostText(posts.data.overall)}
              </p>
              <p className="muted">
                {posts.data.overall.posts === 0
                  ? 'No post has been accepted yet.'
                  : `${posts.data.overall.posts} accepted.`}
              </p>
            </>
          )}
          <a href="/treasury" className="btn" onClick={open('/treasury')}>
            Open Treasury and Costs
          </a>
        </Tile>
        <Tile id="home-quests" title="Quest Board at a glance">
          {quests.state === 'loading' && <Waiting />}
          {quests.state === 'error' && <Failed what="The Quest Board" />}
          {board && (
            <ul className="stat-list" aria-label="Quests by state">
              {BOARD_STATES.map((state) => (
                <li key={state}>
                  <span>
                    {state === 'awaiting_seal'
                      ? 'Awaiting Seal'
                      : state === 'dead'
                        ? 'Dead letters'
                        : `${state[0]?.toUpperCase()}${state.slice(1)}`}
                  </span>
                  <strong>{board[state].length}</strong>
                </li>
              ))}
            </ul>
          )}
          <a href="/quests" className="btn" onClick={open('/quests')}>
            Open the Quest Board
          </a>
        </Tile>
      </div>
    </div>
  )
}
