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
