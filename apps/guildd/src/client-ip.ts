/** Bucket used when no address is known; callers share it, so the limit fails strict, not open. */
export const UNKNOWN_CLIENT = 'unknown'

/**
 * Derives the client address used to key rate limits.
 *
 * The socket's peer address is the default and the only value a client cannot forge.
 * `X-Forwarded-For` is read only when `trustProxy` is set (env `TRUST_PROXY=true`, meaning exactly
 * one trusted reverse proxy fronts guildd and appends the peer it saw): then the LAST entry is
 * used, because earlier entries are client-supplied. Without a proxy, never enable it.
 */
export function clientAddress(input: {
  socket: string | undefined
  forwardedFor: string | undefined
  trustProxy: boolean
}): string {
  if (input.trustProxy && input.forwardedFor) {
    const last = input.forwardedFor.split(',').at(-1)?.trim()
    if (last) {
      return last
    }
  }
  return input.socket || UNKNOWN_CLIENT
}
