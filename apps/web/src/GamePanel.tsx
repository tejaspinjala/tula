import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react'
import { type Banner, bannerFor } from './banners'
import { CharacterPanel } from './CharacterPanel'
import { initialTalk, talkReducer } from './game/interact'
import type { LookChoice } from './game/look'
import { hallsToFetch, mergeTexts } from './game/missive-texts'
import { deriveScene, type SceneQuest, type SceneState } from './game/scene'
import type { GameHandle } from './game/start'
import { readEventFrame, sceneSummary, teleportLabel } from './game/text'
import { announceRoom } from './game/walk'
import { loadGuildMasterLook } from './guild-master-look'
import { loadHistory } from './history'
import { InspectCard } from './InspectCard'
import { LiveEvents } from './live-events'
import { loadMissives } from './missives'
import { prefersReducedMotion } from './motion'
import type { Session } from './passkeys'
import { fetchStreamTicket, loadQuests, questStreamUrl } from './quests'
import type { ReplayEvent } from './replay'
import { loadRoster, type Roster } from './roster'
import { reconnectDelayMs, streamNotice } from './stream-retry'
import { TalkDialog } from './TalkDialog'
import { DialogueBox, ItemGet, PixelButton } from './ui/pixel'

const BANNER_MS = 4000

/** What the home hands to whatever draws over the world (the HUD and the Bag). */
export interface WorldSlots {
  /** The zoom, teleport, replay and character controls, for the Bag's Hall page. */
  hallControls: ReactNode
  /** Returns keyboard focus to the world after an overlay closes. */
  focusWorld: () => void
  /** Opens the talk conversation with a Member (the Guild chat's way to address one). */
  talkTo: (memberId: string) => void
}

/**
 * The Guild Hall as home: a full-screen pixel game (Phaser 4, loaded on demand) that renders the
 * live event stream. It only renders: no governance and no writes, only navigation to Bag pages.
 * The scrubber replays the log with the same fold the Ledger of Deeds uses; accessible live
 * regions say what the canvas shows; live events arrive as ItemGet banners; the game pauses
 * while the tab is hidden. Overlays are drawn by `children`, inside the world.
 */
export function GamePanel({
  session,
  navigate,
  children,
}: {
  session: Session
  navigate: (path: string) => void
  children: (slots: WorldSlots) => ReactNode
}) {
  const [banner, setBanner] = useState<Banner | null>(null)
  const [roster, setRoster] = useState<Roster | null>(null)
  const [quests, setQuests] = useState<(SceneQuest & { state: string })[]>([])
  const [talk, dispatchTalk] = useReducer(talkReducer, initialTalk)
  const [events, setEvents] = useState<ReplayEvent[]>([])
  const [position, setPosition] = useState<number | null>(null)
  const [failed, setFailed] = useState(false)
  const [loadError, setLoadError] = useState(false)
  // Failed connect or load attempts in a row; after a few the Hall says so in-world.
  const [streamFailures, setStreamFailures] = useState(0)
  const [roomSlot, setRoomSlot] = useState<number | null>(null)
  // The Guild Master's saved look (from the server), and whether the customization screen is open.
  const [look, setLook] = useState<LookChoice | null>(null)
  const [customizing, setCustomizing] = useState(false)
  // The Member whose greeting shows in the DialogueBox before the conversation opens.
  const [speaking, setSpeaking] = useState<string | null>(null)
  const speakingNow = useRef<string | null>(null)
  speakingNow.current = speaking
  const known = useRef<SceneState | null>(null)
  const [missiveTexts, setMissiveTexts] = useState<Record<string, string>>({})
  const asked = useRef(new Set<string>())
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
                state: q.state,
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
      let opened = false
      socket = new WebSocket(
        questStreamUrl(session, window.location.origin, lastSeq.current, ticket)
      )
      socket.onopen = () => {
        opened = true
      }
      socket.onmessage = (message) => {
        attempt = 0
        setStreamFailures(0)
        const event = readEventFrame(String(message.data))
        if (event) {
          setBanner(bannerFor(event))
          if (event.type.startsWith('quest.')) {
            // The Quest facts (title, owner) come from the board; refresh before drawing.
            refreshQuests().then(() => !closed && append(event))
          } else {
            append(event)
          }
        }
      }
      socket.onclose = () => {
        if (opened) {
          attempt = 0
          setStreamFailures(0)
        }
        retry()
      }
    }

    function retry(again: () => void = connect) {
      if (!closed) {
        // Jittered backoff so many tabs reloaded together do not retry in lockstep.
        const wait = reconnectDelayMs(attempt, Math.random())
        attempt += 1
        setStreamFailures(attempt)
        timer = setTimeout(again, wait)
      }
    }

    lastSeq.current = 0
    // The character is cosmetic: if it cannot load, the hall still draws the default one.
    loadGuildMasterLook(session, fetch)
      .then((saved) => !closed && setLook(saved))
      .catch(() => undefined)
    const load = () =>
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
              state: q.state,
            }))
          )
          setEvents(history)
          lastSeq.current = history.reduce((max, e) => Math.max(max, e.seq), 0)
          setLoadError(false)
          attempt = 0
          setStreamFailures(0)
          connect()
        })
        .catch(() => {
          if (!closed) {
            // A rate-limited or briefly unreachable load backs off and tries again, never dead-ends.
            setLoadError(true)
            retry(load)
          }
        })
    load()
    return () => {
      closed = true
      clearTimeout(timer)
      socket?.close()
    }
  }, [session])

  // Events carry Missive ids only: the real text is read through the session-guarded Hall route.
  useEffect(() => {
    if (!session) {
      return
    }
    for (const hallId of hallsToFetch(events, missiveTexts)) {
      const key = `${hallId}:${events.length}`
      if (asked.current.has(key)) {
        continue
      }
      asked.current.add(key)
      loadMissives(session, fetch, hallId, { limit: 50 })
        .then((page) => setMissiveTexts((known) => mergeTexts(known, page.missives)))
        .catch(() => undefined)
    }
  }, [session, events, missiveTexts])

  const at = position === null ? events.length : Math.min(position, events.length)
  const scene = useMemo(
    () =>
      roster
        ? deriveScene({
            roster,
            quests,
            events,
            upTo: at >= events.length ? null : (events[at - 1]?.seq ?? 0),
            missiveTexts,
            now: at >= events.length ? Date.now() : undefined,
          })
        : null,
    [roster, quests, events, at, missiveTexts]
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
          seed: session.guildId,
          onHandIn: () => setBanner({ verb: 'Quest', noun: 'complete', danger: false }),
          onOpenSeal: () => open.current('/seals'),
          onRoom: setRoomSlot,
          onNear: (target) => dispatchTalk({ type: 'near', target }),
          onInteract: () => speakingNow.current === null && dispatchTalk({ type: 'interact' }),
          onInspect: (id) => {
            if (known.current?.members[id] && speakingNow.current === null) {
              dispatchTalk({ type: 'inspect', id })
            }
          },
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
    known.current = scene
    if (scene) {
      handle.current?.render(scene)
    }
  }, [scene])

  // The game may finish loading after the first scene is ready: render again when it appears.
  useEffect(() => {
    const id = setInterval(() => {
      if (scene && handle.current) {
        handle.current.render(scene)
        if (look) {
          handle.current.setLook(look)
        }
        clearInterval(id)
      }
    }, 250)
    return () => clearInterval(id)
  }, [scene, look])

  useEffect(() => {
    if (look) {
      handle.current?.setLook(look)
    }
  }, [look])

  // A banner stays long enough to read, then clears (a newer event replaces it sooner).
  useEffect(() => {
    if (!banner) {
      return
    }
    const id = setTimeout(() => setBanner(null), BANNER_MS)
    return () => clearTimeout(id)
  }, [banner])

  const summary = scene ? sceneSummary(scene) : 'Loading the guild hall.'
  const focusWorld = useCallback(() => frame.current?.focus(), [])

  const hallControls = (
    <div className="hall-tools">
      <div className="game-controls">
        <PixelButton onClick={() => handle.current?.zoomBy(0.5)}>Zoom in</PixelButton>
        <PixelButton onClick={() => handle.current?.zoomBy(-0.5)}>Zoom out</PixelButton>
        <PixelButton onClick={() => handle.current?.fit()}>Fit hall</PixelButton>
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
              <option key={room.hallId} value={slot} disabled={room.locked}>
                {teleportLabel(room)}
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
        <PixelButton onClick={() => setCustomizing((open) => !open)}>
          Customize character
        </PixelButton>
      </div>
      {customizing && (
        <CharacterPanel
          session={session}
          fetcher={fetch}
          saved={look}
          onPreview={(draft) => handle.current?.setLook(draft)}
          onSaved={(stored) => {
            setLook(stored)
            setCustomizing(false)
          }}
          onCancel={() => setCustomizing(false)}
        />
      )}
    </div>
  )

  return (
    <section aria-label="The Guild Hall" className="world">
      <div ref={frame} className="game-frame" tabIndex={-1} data-testid="game-frame" />
      <p className="sr-only" role="status" aria-live="polite" data-testid="game-summary">
        {summary}
      </p>
      <p className="sr-only" role="status" aria-live="polite" data-testid="game-location">
        {announceRoom(roomSlot === null ? null : scene?.rooms[roomSlot]?.name, roomSlot !== null)}
      </p>
      {/* The talk prompt floats above the walk controls, so on a phone it is never under them. */}
      <p aria-live="polite" className="talk-prompt" data-testid="game-prompt">
        {talk.near && talk.open === null && (
          <PixelButton onClick={() => dispatchTalk({ type: 'interact' })}>
            {talk.near.kind === 'sealDesk'
              ? 'Open the Seal desk (E)'
              : `Inspect ${scene?.members[talk.near.id]?.name ?? 'the Member'} (E)`}
          </PixelButton>
        )}
      </p>
      {banner && <ItemGet verb={banner.verb} noun={banner.noun} danger={banner.danger} />}
      {(failed || loadError) && (
        <p role="alert" className="world-alert">
          The guild hall could not load everything; retrying through the stream.
        </p>
      )}
      {streamNotice(streamFailures) !== null && (
        <p role="status" className="world-alert">
          {streamNotice(streamFailures)}
        </p>
      )}
      <InspectCard
        session={session}
        fetcher={fetch}
        memberId={speaking === null ? talk.inspect : null}
        scene={scene}
        quests={quests}
        events={events}
        onTalk={() => setSpeaking(talk.inspect)}
        onFollow={(id) => {
          dispatchTalk({ type: 'close' })
          handle.current?.follow(id)
          focusWorld()
        }}
        onClose={() => {
          dispatchTalk({ type: 'close' })
          focusWorld()
        }}
      />
      {speaking !== null && scene?.members[speaking] && (
        <Greeting
          name={scene.members[speaking].name}
          onDone={() => {
            setSpeaking(null)
            dispatchTalk({ type: 'talk' })
          }}
        />
      )}
      <TalkDialog
        session={session}
        fetcher={fetch}
        state={talk}
        dispatch={dispatchTalk}
        onDismiss={() => setTimeout(focusWorld, 0)}
        scene={scene}
        quests={quests}
        navigate={navigate}
      />
      <LiveEvents.Provider value={events}>
        {children({
          hallControls,
          focusWorld,
          talkTo: (id) => {
            dispatchTalk({ type: 'inspect', id })
            dispatchTalk({ type: 'talk' })
          },
        })}
      </LiveEvents.Provider>
    </section>
  )
}

/** The Member's greeting in the DialogueBox, before the conversation opens. */
function Greeting({ name, onDone }: { name: string; onDone: () => void }) {
  const dock = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    dock.current?.querySelector('button')?.focus()
  }, [])
  return (
    <div className="world-dialogue" ref={dock}>
      <DialogueBox
        speaker={name}
        lines={['Guild Master! What would you have of me?']}
        onDone={onDone}
      />
    </div>
  )
}
