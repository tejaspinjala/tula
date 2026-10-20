/** Longest wait between reconnect attempts, in ms. */
export const MAX_RECONNECT_MS = 30_000

/** Reconnect delay stub (red): no backoff yet. */
export function reconnectDelayMs(_attempt: number, _random: number): number {
  return 0
}

/** In-world notice stub (red): never says anything. */
export function streamNotice(_failures: number): string | null {
  return null
}
