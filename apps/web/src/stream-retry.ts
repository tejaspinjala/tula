/** Longest wait between reconnect attempts, in ms (the stream-ticket limit window is a minute). */
export const MAX_RECONNECT_MS = 30_000
/** Failed attempts in a row before the Hall tells the Guild Master in-world. */
export const NOTICE_AFTER = 3

/**
 * How long to wait before reconnect number `attempt` (0-based): the ceiling doubles from 500 ms up
 * to {@link MAX_RECONNECT_MS}, and the wait is jittered between half the ceiling and all of it
 * (`random` is a value in [0, 1)) so tabs reloaded together do not retry in lockstep.
 */
export function reconnectDelayMs(attempt: number, random: number): number {
  const ceiling = Math.min(MAX_RECONNECT_MS, 500 * 2 ** Math.min(attempt, 20))
  return ceiling / 2 + random * (ceiling / 2)
}

/** The in-world line for `failures` failed attempts in a row, or null while a retry is still routine. */
export function streamNotice(failures: number): string | null {
  return failures >= NOTICE_AFTER
    ? "The Hall's messenger cannot reach the guild yet; trying again shortly."
    : null
}

/** Counts failed attempts in a row; shared by the load, ticket and socket retries of one Hall. */
export interface Backoff {
  /** Records one more failure; returns the wait before the next attempt and the failures in a row. */
  next: (random: number) => { wait: number; failures: number }
  /** Forgets all failures (the stream proved healthy). */
  reset: () => void
}

/** A fresh {@link Backoff} with no failures. */
export function createBackoff(): Backoff {
  let attempt = 0
  return {
    next: (random) => {
      const wait = reconnectDelayMs(attempt, random)
      attempt += 1
      return { wait, failures: attempt }
    },
    reset: () => {
      attempt = 0
    },
  }
}

/** What the page does with a live stream's events. */
export interface StreamCallbacks {
  /** A raw frame arrived. */
  onMessage: (data: string) => void
  /** The socket closed: wait `wait` ms, then reconnect; `failures` is the count in a row. */
  onRetry: (wait: number, failures: number) => void
  /** The first frame arrived, so the stream is healthy again. */
  onHealthy?: () => void
  /** Source of jitter in [0, 1). */
  random?: () => number
}

/**
 * The `message` and `close` handlers to wire onto a stream socket. Only a received frame proves the
 * stream healthy: a socket that upgrades and is then dropped (a ticket rejected after the upgrade)
 * still counts as a failure, so the backoff keeps growing and the notice shows.
 */
export function streamHandlers(
  backoff: Backoff,
  callbacks: StreamCallbacks
): { message: (data: string) => void; close: () => void } {
  const random = callbacks.random ?? Math.random
  return {
    message: (data) => {
      backoff.reset()
      callbacks.onHealthy?.()
      callbacks.onMessage(data)
    },
    close: () => {
      const { wait, failures } = backoff.next(random())
      callbacks.onRetry(wait, failures)
    },
  }
}
