import { useEffect, useRef, useState } from 'react'
import type { Session } from './passkeys'
import {
  BOARD_STATES,
  type BoardQuest,
  fetchStreamTicket,
  groupByState,
  loadQuests,
  questStreamUrl,
  readQuestFrame,
} from './quests'

const COLUMN_NAMES: Record<BoardQuest['state'], string> = {
  queued: 'Queued',
  active: 'Active',
  awaiting_seal: 'Awaiting Seal',
  done: 'Done',
  dead: 'Dead letters',
}

/** Longest wait before the stream reconnects. */
const MAX_RECONNECT_MS = 10_000

/**
 * The Quest Board in the ledger view: Quests by state, kept live from the event stream. Every
 * Quest event (and each reconnect) reloads the list; dead-lettered Quests have their own column.
 */
export function QuestBoardPanel({ session }: { session: Session | null }) {
  const [quests, setQuests] = useState<BoardQuest[]>([])
  const [failed, setFailed] = useState(false)
  const lastSeq = useRef(0)

  useEffect(() => {
    if (!session) {
      setQuests([])
      return
    }
    let closed = false
    let socket: WebSocket | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let attempt = 0

    const refresh = () =>
      loadQuests(session, fetch)
        .then((loaded) => {
          if (!closed) {
            setQuests(loaded)
            setFailed(false)
          }
        })
        .catch(() => !closed && setFailed(true))

    const connect = async () => {
      // Each connection, including every reconnect, needs a fresh single-use ticket.
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
        const read = readQuestFrame(String(message.data))
        if (read.seq !== null) {
          lastSeq.current = Math.max(lastSeq.current, read.seq)
        }
        if (read.refresh) {
          refresh()
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
    refresh()
    connect()
    return () => {
      closed = true
      clearTimeout(timer)
      socket?.close()
    }
  }, [session])

  const board = groupByState(quests)

  return (
    <section aria-labelledby="quests-heading" className="mt-8">
      <h2 id="quests-heading" className="text-xl font-semibold">
        Quest Board
      </h2>
      {!session && <p className="mt-4">Sign in with a passkey to see the Quest Board.</p>}
      {failed && <p role="alert">The Quest Board could not be loaded.</p>}
      {session && (
        <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-5" aria-live="polite">
          {BOARD_STATES.map((state) => (
            <div key={state}>
              <h3 className="font-medium">
                {COLUMN_NAMES[state]} ({board[state].length})
              </h3>
              <ul aria-label={COLUMN_NAMES[state]} className="mt-2 flex flex-col gap-2">
                {board[state].map((quest) => (
                  <li key={quest.id}>
                    <strong>{quest.title}</strong>
                    <div>
                      {quest.hallId} / {quest.ownerId}
                    </div>
                    <div>
                      Round {quest.round} of {quest.roundLimit}
                    </div>
                    {quest.state === 'dead' && quest.lastError && <div>{quest.lastError}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
