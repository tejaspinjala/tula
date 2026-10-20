import { useEffect, useMemo, useRef, useState } from 'react'
import { deriveScene, type SceneQuest } from './game/scene'
import type { GameHandle } from './game/start'
import { readEventFrame, sceneSummary } from './game/text'
import { announceRoom } from './game/walk'
import { loadHistory } from './history'
import { prefersReducedMotion } from './motion'
import type { Session } from './passkeys'
import { fetchStreamTicket, loadQuests, questStreamUrl } from './quests'
import type { ReplayEvent } from './replay'
import { loadRoster, type Roster } from './roster'

const MAX_RECONNECT_MS = 10_000

/**
 * The Guild Hall: a pixel game (Phaser 4, loaded on demand) that renders the live event stream.
 * It only renders: no governance and no writes, only navigation to the ledger. The scrubber
 * replays the log with the same fold the Timeline uses; an accessible live region says what the
 * canvas shows; the game pauses while the tab is hidden.
 */
export function GamePanel({
  session,
  navigate,
}: {
  session: Session | null
  navigate: (path: string) => void
}) {
  const [roster, setRoster] = useState<Roster | null>(null)
  const [quests, setQuests] = useState<SceneQuest[]>([])
  const [events, setEvents] = useState<ReplayEvent[]>([])
  const [position, setPosition] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [roomSlot, setRoomSlot] = useState<number | null>(null)
  const frame = useRef<HTMLDivElement | null>(null)
  const handle = useRef<GameHandle | null>(null)
  const lastSeq = useRef(0)
  const open = useRef(navigate)
  open.current = navigate

  // Load the roster, the Quests and the log, then follow the stream.
  useEffect(() => {
    if (!session) {
      return
    }
    let closed = false
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const refreshQuests = () =>
      loadQuests(session, fetch)
        .then((loaded) => {
          if (!closed) {
            setQuests(
              loaded.map((q) => ({
                id: q.id,
                title: q.title,
                hallId: q.hallId,
                ownerId: q.ownerId,
              }))
            )
          }
        })
        .catch(() => !closed && setFailed(true))

    const append = (event: ReplayEvent) => {
      lastSeq.current = Math.max(lastSeq.current, event.seq)
      setEvents((prev) =>
        prev.some((e) => e.seq === event.seq)
          ? prev
          : [...prev, event].sort((a, b) => a.seq - b.seq)
      )
    }

    const connect = async () => {
      const ticket = await fetchStreamTicket(session, fetch).catch(() => null)
      if (closed) {
        return
      }
      if (ticket === null) {
        retry()
        return
      }
      socket = new WebSocket(
        questStreamUrl(session, window.location.origin, lastSeq.current, ticket)
      )
      socket.onmessage = (message) => {
        attempt = 0
        const event = readEventFrame(String(message.data))
        if (event) {
          if (event.type.startsWith('quest.')) {
            // The Quest facts (title, owner) come from the board; refresh before drawing.
            refreshQuests().then(() => !closed && append(event))
          } else {
            append(event)
          }
        }
      }
      socket.onclose = retry
    }

    function retry() {
      if (!closed) {
        // Jittered backoff so many tabs do not reconnect in lockstep.
        const ceiling = Math.min(MAX_RECONNECT_MS, 500 * 2 ** attempt)
        attempt += 1
        timer = setTimeout(connect, ceiling / 2 + Math.random() * (ceiling / 2))
      }
    }

    lastSeq.current = 0
    Promise.all([
      loadRoster(session, fetch),
      loadQuests(session, fetch),
      loadHistory(session, fetch),
    ])
      .then(([loadedRoster, loadedQuests, history]) => {
        if (closed) {
          return
        }
        setRoster(loadedRoster)
        setQuests(
          loadedQuests.map((q) => ({
            id: q.id,
            title: q.title,
            hallId: q.hallId,
            ownerId: q.ownerId,
          }))
        )
        setEvents(history)
        lastSeq.current = history.reduce((max, e) => Math.max(max, e.seq), 0)
        setLoadError(false)
        connect()
      })
      .catch(() => !closed && setLoadError(true))
    return () => {
      closed = true
      clearTimeout(timer)
      socket?.close()
    }
  }, [session])

  const at = position === null ? events.length : Math.min(position, events.length)
  const scene = useMemo(
    () =>
      roster
        ? deriveScene({
            roster,
            quests,
            events,
            upTo: at >= events.length ? null : (events[at - 1]?.seq ?? 0),
          })
        : null,
    [roster, quests, events, at]
  )

  // Boot Phaser on demand (a dynamic import keeps it out of the main bundle).
  useEffect(() => {
    const parent = frame.current
    if (!session || !parent) {
      return
    }
    let gone = false
    let started: GameHandle | null = null
    import('./game/start')
      .then(({ startGame }) => {
        if (gone) {
          return
        }
        started = startGame(parent, {
          reducedMotion: prefersReducedMotion(
            typeof matchMedia === 'function' ? matchMedia.bind(globalThis) : undefined
          ),
          onOpenSeal: () => open.current('/seals'),
          onRoom: setRoomSlot,
        })
        handle.current = started
      })
      .catch(() => !gone && setLoadError(true))
    const onVisibility = () => started?.setPaused(document.hidden)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      gone = true
      document.removeEventListener('visibilitychange', onVisibility)
      started?.destroy()
      handle.current = null
    }
  }, [session])

  useEffect(() => {
    if (scene) {
      handle.current?.render(scene)
    }
  }, [scene])

  // The game may finish loading after the first scene is ready: render again when it appears.
  useEffect(() => {
    const id = setInterval(() => {
      if (scene && handle.current) {
        handle.current.render(scene)
        clearInterval(id)
      }
    }, 250)
    return () => clearInterval(id)
  }, [scene])

  const summary = scene ? sceneSummary(scene) : 'Loading the guild hall.'

  return (
    <section aria-labelledby="game-heading" className="card">
      <h2 id="game-heading" className="card-title">
        Guild Hall
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see the guild hall.</p>}
      {session && (
        <>
          <div className="game-controls">
            <button type="button" onClick={() => handle.current?.zoomBy(0.5)}>
              Zoom in
            </button>
            <button type="button" onClick={() => handle.current?.zoomBy(-0.5)}>
              Zoom out
            </button>
            <button type="button" onClick={() => handle.current?.fit()}>
              Fit hall
            </button>
            <label className="game-teleport">
              Teleport to
              <select
                value=""
                onChange={(e) => {
                  const value = e.target.value
                  if (value !== '') {
                    handle.current?.teleport(value === 'entrance' ? null : Number(value))
                  }
                }}
              >
                <option value="">choose a room</option>
                <option value="entrance">Entrance</option>
                {(scene?.rooms ?? []).map((room, slot) => (
                  <option key={room.hallId} value={slot}>
                    {room.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="game-scrub">
              Replay
              <input
                type="range"
                min={0}
                max={events.length}
                value={at}
                onChange={(e) => {
                  const value = Number(e.target.value)
                  setPosition(value >= events.length ? null : value)
                }}
              />
            </label>
            <span className="muted">
              {position === null ? 'live' : `event ${at} of ${events.length}`}
            </span>
          </div>
          <div ref={frame} className="game-frame" data-testid="game-frame" />
          <p role="status" aria-live="polite" className="muted" data-testid="game-summary">
            {summary}
          </p>
          <p role="status" aria-live="polite" className="muted" data-testid="game-location">
            {announceRoom(
              roomSlot === null ? null : scene?.rooms[roomSlot]?.name,
              roomSlot !== null
            )}
          </p>
          {(failed || loadError) && (
            <p role="alert" className="muted">
              The guild hall could not load everything; retrying through the stream.
            </p>
          )}
        </>
      )}
    </section>
  )
}
