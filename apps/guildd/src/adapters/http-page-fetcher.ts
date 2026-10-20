import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { PageFetcher } from '../ports/page-fetcher'
import type { FetchLike } from './brave-search-provider'

/** Largest body read from a page, in bytes. */
export const DEFAULT_MAX_PAGE_BYTES = 500_000

function ipv4Private(ip: string): boolean {
  const [a = 0, b = 0] = ip.split('.').map(Number)
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  )
}

/**
 * True for an address a page fetch must never reach: loopback, private, link-local, carrier-grade
 * NAT, multicast and reserved IPv4 ranges, their IPv6 counterparts, and IPv4-mapped IPv6.
 * Anything that is not a valid IP is treated as private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    return ipv4Private(address)
  }
  if (kind !== 6) {
    return true
  }
  const ip = address.toLowerCase()
  if (ip === '::' || ip === '::1') {
    return true
  }
  const mapped = /^::ffff:(.+)$/.exec(ip)?.[1]
  if (mapped !== undefined) {
    if (mapped.includes('.')) {
      return ipv4Private(mapped)
    }
    const [hi = '0', lo = '0'] = mapped.split(':')
    const high = Number.parseInt(hi, 16)
    const low = Number.parseInt(lo, 16)
    return ipv4Private(`${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`)
  }
  const first = Number.parseInt(ip.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}

/** The readable text of an HTML or plain-text body: scripts, styles and tags removed, whitespace collapsed. */
function readableText(body: string): string {
  return body
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m] ?? m)
    .replace(/\s+/g, ' ')
    .trim()
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) {
    return ''
  }
  const decoder = new TextDecoder()
  let text = ''
  let read = 0
  while (read < maxBytes) {
    const { done, value } = await reader.read()
    if (done) {
      break
    }
    const room = Math.min(value.byteLength, maxBytes - read)
    text += decoder.decode(value.subarray(0, room), { stream: true })
    read += room
  }
  await reader.cancel().catch(() => {})
  return text + decoder.decode()
}

/** Settings of an {@link HttpPageFetcher}. */
export interface HttpPageFetcherOptions {
  /** Resolves a host to its addresses; defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>
  /** Replaces `fetch` in tests. */
  fetchImpl?: FetchLike
  /** Largest body read, in bytes; defaults to {@link DEFAULT_MAX_PAGE_BYTES}. */
  maxBytes?: number
  /** Most characters of text extracted from a page. */
  maxTextChars?: number
  /** Replaces the HTTPS connection in tests. */
  transport?: (request: {
    url: string
    address: string
    family: 4 | 6
    signal: AbortSignal
  }) => Promise<Response>
}

/**
 * {@link PageFetcher} over HTTPS GET. It only reads: https URLs only, hosts that are or resolve to
 * a private, loopback or link-local address are refused before any request (so a search result
 * cannot point guildd at its own network), redirects are not followed (a redirect could land on
 * one), only `text/*` bodies are read, and at most `maxBytes` of them. The check and the request
 * resolve the host separately; the closed egress allowlist and the refusal of redirects are the
 * backstop for a host that changes its answer in between.
 */
export class HttpPageFetcher implements PageFetcher {
  private readonly resolve: (host: string) => Promise<string[]>
  private readonly fetchImpl: FetchLike
  private readonly maxBytes: number

  constructor(options: HttpPageFetcherOptions = {}) {
    this.resolve =
      options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
    this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init))
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES
  }

  async fetch(rawUrl: string, request: { signal: AbortSignal }): Promise<string> {
    const url = new URL(rawUrl)
    if (url.protocol !== 'https:') {
      throw new Error('page_url_not_https')
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new Error('page_host_private')
    }
    const addresses = isIP(host) === 0 ? await this.resolve(host) : [host]
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
      throw new Error('page_host_private')
    }
    const response = await this.fetchImpl(url.href, {
      redirect: 'manual',
      signal: request.signal,
      headers: { accept: 'text/html,text/plain;q=0.9' },
    })
    if (response.status !== 200) {
      throw new Error(`page_http_${response.status}`)
    }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/')) {
      throw new Error('page_not_text')
    }
    return readableText(await readBounded(response, this.maxBytes)).slice(0, this.maxBytes)
  }
}
