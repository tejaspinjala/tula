import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { describeEvent } from './event-text'
import { loadHistory } from './history'
import { prefersReducedMotion, scrollBehavior } from './motion'
import type { Session } from './passkeys'
import { loadQuests } from './quests'
import { type ReplayEvent, replayTo } from './replay'
import { groupRepeats, relativeTime, stateWord } from './timeline-format'
import { formatCents } from './treasury'
import { PixelButton } from './ui/pixel'
import { WorkSection } from './WorkSection'

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
  const [names, setNames] = useState<Record<string, string>>({})
  const known = useRef(0)
  const listEnd = useRef<HTMLLIElement | null>(null)

  const refresh = useCallback(() => {
    if (!session) {
      setEvents([])
      return
    }
    loadQuests(session, fetch)
      .then((quests) => setNames(Object.fromEntries(quests.map((q) => [q.id, q.title]))))
      .catch(() => undefined)
    loadHistory(session, fetch)
      .then((loaded) => {
        const fresh = loaded.slice(known.current)
        if (known.current > 0 && fresh.length > 0) {
          setAnnouncement(fresh.map((e) => describeEvent(e)).join('. '))
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
  const shown = groupRepeats(
    applied.slice(-VISIBLE).map((event) => ({ event, text: describeEvent(event, names) }))
  )
  const nowMs = Date.now()

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
    <WorkSection id="timeline" title="Replay the day">
      {!session && <p>Sign in with a passkey to replay the guild's day.</p>}
      {failed && <p role="alert">The event log could not be loaded.</p>}
      {session && events.length === 0 && !failed && <p>No events yet.</p>}
      {events.length > 0 && (
        <div className="work-body">
          <div className="work-actions">
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
            <PixelButton onClick={() => setPosition(null)}>Back to now</PixelButton>
            <PixelButton onClick={refresh}>Refresh log</PixelButton>
          </div>
          <p>
            Showing {at} of {events.length} events
          </p>
          <ul aria-label="Replayed state" className="work-log">
            {(Object.keys(state.quests) as Array<keyof typeof state.quests>).map((s) => (
              <li key={s}>
                Quests {stateWord(s)}: {state.quests[s].length}
              </li>
            ))}
            {(Object.keys(state.seals) as Array<keyof typeof state.seals>).map((s) => (
              <li key={s}>
                Seals {stateWord(s)}: {state.seals[s].length}
              </li>
            ))}
            <li>Paused Halls: {state.pausedHalls.length}</li>
            <li>
              Treasury: operating {formatCents(state.balances.operating)}, reserve{' '}
              {formatCents(state.balances.reserve)}, profit {formatCents(state.balances.profit)}
            </li>
            <li>Notes: {state.notes}</li>
          </ul>
          <ol aria-label="Events" className="work-log">
            {shown.map(({ event, text, count }) => (
              <li key={event.seq}>
                <time dateTime={event.occurredAt} title={event.occurredAt}>
                  {relativeTime(event.occurredAt, nowMs)}
                </time>{' '}
                {text}
                {count > 1 ? ` (x${count})` : ''}
              </li>
            ))}
            <li ref={listEnd} aria-hidden="true" />
          </ol>
        </div>
      )}
      <div aria-live="polite" role="status" className="sr-only">
        {announcement}
      </div>
    </WorkSection>
  )
}
