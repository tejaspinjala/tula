import type { Db } from './db/client'
import { eventsAfter, type GuildEvent } from './events'

/** The slice of a websocket the hub drives. */
export interface StreamSocket {
  send(data: string): void
  /** Bytes queued for the peer and not yet written. */
  bufferedAmount(): number
  close(code: number, reason: string): void
}

/** Tuning for {@link createEventHub}. */
export interface EventHubOptions {
  /** Fallback poll for notifications that were missed; defaults to 5000 ms. */
  pollMs?: number | undefined
  /** Sockets allowed per guild; defaults to 8. */
  maxSocketsPerGuild?: number | undefined
  /** A socket buffering more than this many bytes is closed as too slow; defaults to 1 MiB. */
  maxBufferedBytes?: number | undefined
}

interface Subscriber {
  socket: StreamSocket
  cursor: number
  ready: boolean
}

interface GuildState {
  subs: Set<Subscriber>
  running: boolean
  dirty: boolean
}

/** Handle for one registered socket. */
export interface Subscription {
  /** Starts delivery once the caller has sent its snapshot frame. */
  start(): void
  unsubscribe(): void
}

const BATCH = 100

/**
 * Fans the event log out to live sockets. One LISTEN connection wakes it; each wake costs ONE
 * query per guild (events after the lowest cursor among that guild's sockets), whatever the
 * socket count. Only live sockets and their cursors are held in memory; Postgres is the state.
 */
export function createEventHub(db: Db, options: EventHubOptions = {}) {
  const pollMs = options.pollMs ?? 5000
  const maxPerGuild = options.maxSocketsPerGuild ?? 8
  const maxBuffered = options.maxBufferedBytes ?? 1024 * 1024
  const guilds = new Map<string, GuildState>()
  let listening: Promise<{ unlisten: () => Promise<void> }> | undefined
  let timer: ReturnType<typeof setInterval> | undefined

  function deliver(sub: Subscriber, events: GuildEvent[]) {
    for (const event of events) {
      if (event.seq <= sub.cursor) {
        continue
      }
      if (sub.socket.bufferedAmount() > maxBuffered) {
        sub.socket.close(1013, 'consumer too slow')
        return
      }
      sub.socket.send(JSON.stringify({ type: 'event', event }))
      sub.cursor = event.seq
    }
  }

  async function refresh(guild: string) {
    const state = guilds.get(guild)
    if (!state) {
      return
    }
    if (state.running) {
      state.dirty = true
      return
    }
    state.running = true
    try {
      do {
        state.dirty = false
        const ready = [...state.subs].filter((s) => s.ready)
        if (ready.length === 0) {
          break
        }
        const lowest = Math.min(...ready.map((s) => s.cursor))
        const batch = await db.withGuildStream(guild, (tx) => eventsAfter(tx, lowest, BATCH))
        for (const sub of ready) {
          deliver(sub, batch)
        }
        if (batch.length === BATCH) {
          state.dirty = true
        }
      } while (state.dirty)
    } catch {
      for (const sub of state.subs) {
        sub.socket.close(1011, 'event stream failed')
      }
    } finally {
      state.running = false
    }
  }

  const refreshAll = () => {
    for (const guild of guilds.keys()) {
      void refresh(guild)
    }
  }

  function ensureRunning() {
    listening ??= db.listen('guild_events', (guild) => void refresh(guild), refreshAll)
    listening.catch(() => {
      listening = undefined
    })
    timer ??= setInterval(refreshAll, pollMs)
  }

  return {
    /** Whether the guild has room for another socket. */
    hasRoom: (guild: string) => (guilds.get(guild)?.subs.size ?? 0) < maxPerGuild,
    /** Registers a socket whose last applied seq is `cursor`; delivery waits for `start()`. */
    subscribe(guild: string, cursor: number, socket: StreamSocket): Subscription {
      let state = guilds.get(guild)
      if (!state) {
        state = { subs: new Set(), running: false, dirty: false }
        guilds.set(guild, state)
      }
      const sub: Subscriber = { socket, cursor, ready: false }
      state.subs.add(sub)
      ensureRunning()
      return {
        start() {
          sub.ready = true
          void refresh(guild)
        },
        unsubscribe() {
          const current = guilds.get(guild)
          current?.subs.delete(sub)
          if (current && current.subs.size === 0) {
            guilds.delete(guild)
          }
          if (guilds.size === 0) {
            clearInterval(timer)
            timer = undefined
          }
        },
      }
    },
  }
}

/** The hub over a Db. */
export type EventHub = ReturnType<typeof createEventHub>
