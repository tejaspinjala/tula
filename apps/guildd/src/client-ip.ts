import { isIPv4, isIPv6 } from 'node:net'

/** Bucket used when no address is known; callers share it and get a stricter limit. */
export const UNKNOWN_CLIENT = 'unknown'

/** Expands an IPv6 address to its eight 16-bit groups, or null when it is not valid. */
function groupsOf(address: string): string[] | null {
  const [text] = address.split('%')
  if (!text || !isIPv6(text)) {
    return null
  }
  const [head = '', tail] = text.split('::')
  const side = (part: string) => (part === '' ? [] : part.split(':'))
  const first = side(head)
  const last = tail === undefined ? [] : side(tail)
  const fill = tail === undefined ? 0 : 8 - first.length - last.length
  const groups = [...first, ...Array.from({ length: fill }, () => '0'), ...last]
  return groups.length === 8 ? groups.map((g) => g.toLowerCase().padStart(4, '0')) : null
}

/**
 * Normalises an address into its rate-limit key. IPv4 is itself; an IPv4-mapped IPv6 address is
 * the IPv4 address; any other IPv6 address is keyed by its /64, because a single subscriber
 * typically controls a whole /64 and could otherwise rotate through addresses freely.
 */
function bucketKey(address: string): string {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)
  if (mapped?.[1] && isIPv4(mapped[1])) {
    return mapped[1]
  }
  const groups = groupsOf(address)
  return groups ? `${groups.slice(0, 4).join(':')}::/64` : address
}

/**
 * Derives the client address used to key rate limits.
 *
 * The socket's peer address is the default and the only value a client cannot forge.
 * `X-Forwarded-For` is read only when `trustProxy` is set (env `TRUST_PROXY=true`, meaning exactly
 * one trusted reverse proxy fronts guildd and appends the peer it saw): then the LAST entry is
 * used, because earlier entries are client-supplied. With TRUST_PROXY the origin must be reachable
 * ONLY through that proxy: anyone who can reach guildd directly can forge the header and rotate
 * through unlimited buckets. IPv6 addresses are keyed by /64 (see {@link bucketKey}); with no
 * address at all the result is {@link UNKNOWN_CLIENT}.
 */
export function clientAddress(input: {
  socket: string | undefined
  forwardedFor: string | undefined
  trustProxy: boolean
}): string {
  if (input.trustProxy && input.forwardedFor) {
    const last = input.forwardedFor.split(',').at(-1)?.trim()
    if (last) {
      return bucketKey(last)
    }
  }
  return input.socket ? bucketKey(input.socket) : UNKNOWN_CLIENT
}
