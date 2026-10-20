import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { eventText } from './event-text'
import { loadHistory } from './history'
import { prefersReducedMotion, scrollBehavior } from './motion'
import type { Session } from './passkeys'
import { type ReplayEvent, replayTo } from './replay'
import { formatCents } from './treasury'

/** Most events listed at once, so a long day stays readable. */
const VISIBLE = 20

/**
 * The timeline replay: the Guild Master scrubs back through the day and sees the Quests, Seals,
 * Hall pauses, Treasury balances and notes the event log implies at that point. Every event has
 * screen-reader text, and a polite live region announces events that arrive while watching.
 */
export function TimelinePanel({ session }: { session: Session | null }) {
  const [events, setEvents] = useState<ReplayEvent[]>([])
  const [position, setPosition] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [announcement, setAnnouncement] = useState('')
  const known = useRef(0)
  const listEnd = useRef<HTMLLIElement | null>(null)

  const refresh = useCallback(() => {
    if (!session) {
      setEvents([])
      return
    }
    loadHistory(session, fetch)
      .then((loaded) => {
        const fresh = loaded.slice(known.current)
        if (known.current > 0 && fresh.length > 0) {
          setAnnouncement(fresh.map(eventText).join('. '))
        }
        known.current = loaded.length
        setEvents(loaded)
        setFailed(false)
      })
      .catch(() => setFailed(true))
  }, [session])

  useEffect(refresh, [refresh])

  const at = position === null ? events.length : Math.min(position, events.length)
  const state = useMemo(
    () => replayTo(events, at >= events.length ? null : { seq: events[at - 1]?.seq ?? 0 }),
    [events, at]
  )
  const applied = events.slice(0, at)
  const shown = applied.slice(-VISIBLE)

  useEffect(() => {
    if (at === 0) {
      return
    }
    listEnd.current?.scrollIntoView?.({
      behavior: scrollBehavior(
        prefersReducedMotion(
          typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined
        )
      ),
      block: 'nearest',
    })
  }, [at])

  const toTime = (value: string) => {
    const ms = Date.parse(value)
    if (Number.isNaN(ms)) {
      return
    }
    setPosition(events.filter((e) => Date.parse(e.occurredAt) <= ms).length)
  }

  return (
    <section aria-labelledby="timeline-heading" className="card">
      <h2 id="timeline-heading" className="card-title">
        Timeline
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to replay the guild's day.</p>}
      {failed && <p role="alert">The event log could not be loaded.</p>}
      {session && events.length === 0 && !failed && <p className="mt-4">No events yet.</p>}
      {events.length > 0 && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <label>
              Replay position
              <input
                type="range"
                className="ml-2"
                min={0}
                max={events.length}
                value={at}
                aria-valuetext={`${at} of ${events.length} events`}
                onChange={(e) => setPosition(Number(e.currentTarget.value))}
              />
            </label>
            <label>
              Replay to time
              <input
                type="datetime-local"
                className="ml-2"
                onChange={(e) => toTime(e.currentTarget.value)}
              />
            </label>
            <button type="button" onClick={() => setPosition(null)}>
              Back to now
            </button>
            <button type="button" onClick={refresh}>
              Refresh log
            </button>
          </div>
          <p className="mt-4">
            Showing {at} of {events.length} events
          </p>
          <ul aria-label="Replayed state" className="mt-2 flex flex-col gap-1">
            {(Object.keys(state.quests) as Array<keyof typeof state.quests>).map((s) => (
              <li key={s}>
                Quests {s}: {state.quests[s].length}
              </li>
            ))}
            {(Object.keys(state.seals) as Array<keyof typeof state.seals>).map((s) => (
              <li key={s}>
                Seals {s}: {state.seals[s].length}
              </li>
            ))}
            <li>Paused Halls: {state.pausedHalls.length}</li>
            <li>
              Treasury: operating {formatCents(state.balances.operating)}, reserve{' '}
              {formatCents(state.balances.reserve)}, profit {formatCents(state.balances.profit)}
            </li>
            <li>Notes: {state.notes}</li>
          </ul>
          <ol aria-label="Events" className="mt-4 flex flex-col gap-1">
            {shown.map((event) => (
              <li key={event.seq}>
                <time dateTime={event.occurredAt}>{event.occurredAt}</time> {eventText(event)}
              </li>
            ))}
            <li ref={listEnd} aria-hidden="true" />
          </ol>
        </>
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </section>
  )
}
