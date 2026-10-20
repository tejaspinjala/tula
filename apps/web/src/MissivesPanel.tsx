import { useCallback, useEffect, useRef, useState } from 'react'
import { missiveCount, useLiveEvents } from './live-events'
import { type HallMissive, loadMissives } from './missives'
import type { Session } from './passkeys'
import { loadRoster, type Roster } from './roster'

/** Missives per page. */
const PAGE = 20

/**
 * The Hall's Missives in the Guild Hall view: what its Members said to each other, newest first,
 * a page at a time. The text is other Members' words, so it is only ever rendered as text.
 */
export function MissivesPanel({ session }: { session: Session | null }) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [hallId, setHallId] = useState('')
  const [missives, setMissives] = useState<HallMissive[]>([])
  const [next, setNext] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  // A `missive.sent` event means the list is stale: refetch the first page (text only by route).
  const sentCount = missiveCount(useLiveEvents())

  useEffect(() => {
    if (!session) {
      setRoster(null)
      return
    }
    loadRoster(session, fetch)
      .then((loaded) => {
        setRoster(loaded)
        setHallId((current) => current || (loaded.halls.find((h) => !h.locked)?.id ?? ''))
      })
      .catch(() => setFailed(true))
  }, [session])

  const refresh = useCallback(() => {
    if (!session || hallId === '') {
      setMissives([])
      setNext(null)
      return () => {}
    }
    let live = true
    loadMissives(session, fetch, hallId, { limit: PAGE })
      .then((page) => {
        if (live) {
          setMissives(page.missives)
          setNext(page.next)
          setFailed(false)
        }
      })
      .catch(() => live && setFailed(true))
    return () => {
      live = false
    }
  }, [session, hallId])
  useEffect(() => refresh(), [refresh])
  const seen = useRef(sentCount)
  useEffect(() => {
    if (seen.current === sentCount) {
      return
    }
    seen.current = sentCount
    return refresh()
  }, [sentCount, refresh])

  const older = async () => {
    if (!session || next === null) {
      return
    }
    try {
      const page = await loadMissives(session, fetch, hallId, { limit: PAGE, after: next })
      setMissives((all) => [...all, ...page.missives])
      setNext(page.next)
    } catch {
      setFailed(true)
    }
  }

  const names = new Map<string, string>()
  for (const hall of roster?.halls ?? []) {
    if (hall.captain) {
      names.set(hall.captain.id, hall.captain.name)
    }
    for (const m of hall.members) {
      names.set(m.id, m.name)
    }
  }
  const nameOf = (id: string): string => (id === 'hall' ? 'the Hall' : (names.get(id) ?? id))
  const halls = roster?.halls.filter((h) => !h.locked) ?? []

  return (
    <section aria-labelledby="missives-heading" className="card">
      <h2 id="missives-heading" className="card-title">
        Hall missives
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to read the Hall’s missives.</p>}
      {failed && <p role="alert">The missives could not be loaded.</p>}
      {session && halls.length > 0 && (
        <div className="mt-4">
          <label htmlFor="missive-hall">Hall</label>{' '}
          <select
            id="missive-hall"
            name="missive-hall"
            value={hallId}
            onChange={(e) => setHallId(e.target.value)}
          >
            {halls.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>
      )}
      {session && missives.length === 0 && !failed && (
        <p className="muted mt-4">No missives in this Hall yet.</p>
      )}
      {missives.length > 0 && (
        <ul aria-label="Missives" className="mt-4 flex flex-col gap-2">
          {missives.map((m) => (
            <li key={m.id} data-testid="missive">
              <strong>{nameOf(m.from)}</strong> to {nameOf(m.to)}{' '}
              <time dateTime={m.sentAt} className="muted">
                {m.sentAt.slice(11, 16)}
              </time>
              : {m.text}
            </li>
          ))}
        </ul>
      )}
      {next !== null && (
        <button type="button" className="mt-4" onClick={older}>
          Load older missives
        </button>
      )}
    </section>
  )
}
