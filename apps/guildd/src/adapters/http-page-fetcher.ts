import { lookup } from 'node:dns/promises'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { type PageFetcher, PageRefused } from '../ports/page-fetcher'

/** Largest body read from a page, in bytes. */
export const DEFAULT_MAX_PAGE_BYTES = 500_000
/** Most characters of text extracted from a page. */
export const DEFAULT_MAX_TEXT_CHARS = 2000

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

/** The eight 16-bit groups of an IPv6 address, or null when it is not one. */
function ipv6Groups(address: string): number[] | null {
  let text = address.toLowerCase()
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)?.[1]
  if (tail !== undefined) {
    const [a = 0, b = 0, c = 0, d = 0] = tail.split('.').map(Number)
    text = `${text.slice(0, -tail.length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }
  const halves = text.split('::')
  if (halves.length > 2) {
    return null
  }
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((g) => Number.parseInt(g, 16))
  const head = parse(halves[0] ?? '')
  const rest = parse(halves[1] ?? '')
  const fill = halves.length === 2 ? 8 - head.length - rest.length : 0
  const groups = [...head, ...Array<number>(Math.max(fill, 0)).fill(0), ...rest]
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

/**
 * True for an address a page fetch must never reach. IPv4: loopback, private, link-local,
 * carrier-grade NAT, multicast and reserved ranges. IPv6: only global unicast (2000::/3) outside
 * the special-use blocks passes; addresses that embed an IPv4 one (IPv4-mapped, NAT64
 * 64:ff9b::/96, 6to4 2002::/16) are judged by the embedded address; IPv4-compatible (::/96),
 * Teredo and other 2001::/23, documentation (2001:db8::/32, 3fff::/20) ranges are refused.
 * Anything that is not a valid IP is treated as private (fail closed).
 */
export function isPrivateAddress(address: string): boolean {
  const kind = isIP(address)
  if (kind === 4) {
    return ipv4Private(address)
  }
  const g = kind === 6 ? ipv6Groups(address) : null
  if (g === null) {
    return true
  }
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0) {
    // ::ffff:a.b.c.d is IPv4-mapped; the rest of ::/96 (including :: and ::1) is refused.
    return g5 === 0xffff ? ipv4Private(v4From(g6, g7)) : true
  }
  if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
    return ipv4Private(v4From(g6, g7))
  }
  if (g0 === 0x2002) {
    return ipv4Private(v4From(g1, g2))
  }
  if ((g0 & 0xe000) !== 0x2000) {
    return true
  }
  if (g0 === 0x2001 && g1 < 0x200) {
    return true
  }
  if (g0 === 0x2001 && g1 === 0xdb8) {
    return true
  }
  return g0 === 0x3fff && g1 < 0x1000
}

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
}
const SKIPPED = ['script', 'style', 'noscript'] as const

const isLetter = (code: number): boolean => (code | 32) >= 97 && (code | 32) <= 122

/** True when `body` has the (ASCII, case-insensitive) `word` at `at`. */
function wordAt(body: string, at: number, word: string): boolean {
  if (at + word.length > body.length) {
    return false
  }
  for (let i = 0; i < word.length; i += 1) {
    if ((body.charCodeAt(at + i) | 32) !== word.charCodeAt(i)) {
      return false
    }
  }
  return true
}

/**
 * The readable text of an HTML or plain-text body in one linear pass: tags removed, the content of
 * script, style and noscript elements skipped, a few entities decoded, whitespace collapsed. It
 * stops once `maxChars` of text are out, so hostile markup cannot cost more than the body's length.
 */
function readableText(body: string, maxChars: number): string {
  let out = ''
  let pendingSpace = false
  const push = (piece: string): void => {
    if (out.length >= maxChars) {
      return
    }
    if (pendingSpace && out.length > 0) {
      out += ' '
    }
    pendingSpace = false
    out += piece
  }
  let i = 0
  while (i < body.length && out.length < maxChars) {
    const ch = body.charCodeAt(i)
    if (ch === 60 /* < */) {
      const next = body.charCodeAt(i + 1)
      if (isLetter(next) || next === 47 || next === 33 || next === 63) {
        const closing = next === 47
        const nameAt = closing ? i + 2 : i + 1
        const skipped = closing
          ? undefined
          : SKIPPED.find(
              (n) => wordAt(body, nameAt, n) && !isLetter(body.charCodeAt(nameAt + n.length))
            )
        const end = body.indexOf('>', i + 1)
        i = end === -1 ? body.length : end + 1
        pendingSpace = true
        if (skipped !== undefined && body.charCodeAt(i - 2) !== 47) {
          // Skip to the matching close tag, scanning forward once.
          let j = i
          while (j < body.length) {
            const lt = body.indexOf('</', j)
            if (lt === -1) {
              j = body.length
              break
            }
            if (wordAt(body, lt + 2, skipped)) {
              const gt = body.indexOf('>', lt)
              j = gt === -1 ? body.length : gt + 1
              break
            }
            j = lt + 2
          }
          i = j
        }
        continue
      }
      push('<')
      i += 1
    } else if (ch === 38 /* & */) {
      const entity = Object.keys(ENTITIES).find((e) => body.startsWith(e, i))
      push(entity === undefined ? '&' : (ENTITIES[entity] ?? '&'))
      i += entity === undefined ? 1 : entity.length
    } else if (ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 12) {
      pendingSpace = true
      i += 1
    } else {
      push(body[i] ?? '')
      i += 1
    }
  }
  return out.slice(0, maxChars)
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

/** One HTTPS GET to a pinned address: what {@link HttpPageFetcher} asks of its connection. */
export interface PageTransportRequest {
  url: string
  /** The validated address to connect to; the name in `url` is used only for SNI and `Host`. */
  address: string
  family: 4 | 6
  signal: AbortSignal
}

/** Makes one HTTPS GET to `request.address` and answers the unread response; follows no redirect. */
export type PageTransport = (request: PageTransportRequest) => Promise<Response>

const NO_BODY = new Set([101, 204, 205, 304])

/** The real transport: `node:https` with a `lookup` that can only answer the validated address. */
export function createHttpsTransport(_options: { ca?: string } = {}): PageTransport {
  return (req) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(req.url)
      const host = url.hostname.replace(/^\[|\]$/g, '')
      const call = httpsRequest(
        {
          hostname: host,
          port: url.port === '' ? 443 : Number(url.port),
          path: `${url.pathname}${url.search}`,
          method: 'GET',
          headers: { accept: 'text/html,text/plain;q=0.9', 'accept-encoding': 'identity' },
          servername: isIP(host) === 0 ? host : '',
          lookup: (_name, _options, callback) => callback(null, req.address, req.family),
          signal: req.signal,
        },
        (res) => {
          const iterator = res[Symbol.asyncIterator]()
          const headers = new Headers()
          for (const [name, value] of Object.entries(res.headers)) {
            if (typeof value === 'string') {
              headers.set(name, value)
            }
          }
          const status = res.statusCode ?? 0
          const body = NO_BODY.has(status)
            ? null
            : new ReadableStream<Uint8Array>({
                async pull(controller) {
                  const next = await iterator.next()
                  if (next.done) {
                    controller.close()
                  } else {
                    controller.enqueue(new Uint8Array(Buffer.from(next.value)))
                  }
                },
                cancel() {
                  res.destroy()
                },
              })
          resolve(new Response(body, { status, headers }))
        }
      )
      call.on('error', reject)
      call.end()
    })
}

const httpsTransport = createHttpsTransport()

/** Settings of an {@link HttpPageFetcher}. */
export interface HttpPageFetcherOptions {
  /** Resolves a host to its addresses; defaults to the system resolver. */
  resolve?: (host: string) => Promise<string[]>
  /** Largest body read, in bytes; defaults to {@link DEFAULT_MAX_PAGE_BYTES}. */
  maxBytes?: number
  /** Most characters of text extracted; defaults to {@link DEFAULT_MAX_TEXT_CHARS}. */
  maxTextChars?: number
  /** Replaces the HTTPS connection in tests. */
  transport?: PageTransport
}

/**
 * {@link PageFetcher} over HTTPS GET. It only reads: https URLs only; a host that is, or resolves
 * to, a private, loopback, link-local or otherwise special-use address is refused before any
 * request (so a search result cannot point guildd at its own network). The host is resolved once,
 * every answer is validated, and the connection is then made to a validated address through a
 * `lookup` that can answer nothing else, so a second DNS answer cannot redirect it (SNI and
 * `Host` keep the name). Redirects are not followed, only `text/*` bodies are read, at most
 * `maxBytes` of them, and text extraction is one linear pass that stops at `maxTextChars`.
 * Deterministic refusals throw {@link PageRefused}; a 5xx or a network error throws a plain Error.
 * Note: this does not depend on any egress allowlist; it is guildd, not a sandbox, that connects.
 */
export class HttpPageFetcher implements PageFetcher {
  private readonly resolve: (host: string) => Promise<string[]>
  private readonly maxBytes: number
  private readonly maxTextChars: number
  private readonly transport: PageTransport

  constructor(options: HttpPageFetcherOptions = {}) {
    this.resolve =
      options.resolve ?? (async (host) => (await lookup(host, { all: true })).map((a) => a.address))
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_PAGE_BYTES
    this.maxTextChars = options.maxTextChars ?? DEFAULT_MAX_TEXT_CHARS
    this.transport = options.transport ?? httpsTransport
  }

  async fetch(rawUrl: string, request: { signal: AbortSignal }): Promise<string> {
    const url = URL.canParse(rawUrl) ? new URL(rawUrl) : null
    if (url === null) {
      throw new PageRefused('page_url_invalid')
    }
    if (url.protocol !== 'https:') {
      throw new PageRefused('page_url_not_https')
    }
    const host = url.hostname.replace(/^\[|\]$/g, '')
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new PageRefused('page_host_private')
    }
    const addresses = isIP(host) === 0 ? await this.resolve(host) : [host]
    const address = addresses[0]
    if (address === undefined || addresses.some(isPrivateAddress)) {
      throw new PageRefused('page_host_private')
    }
    const response = await this.transport({
      url: url.href,
      address,
      family: isIP(address) === 6 ? 6 : 4,
      signal: request.signal,
    })
    if (response.status >= 500) {
      throw new Error(`page_http_${response.status}`)
    }
    if (response.status !== 200) {
      throw new PageRefused(`page_http_${response.status}`)
    }
    if (!(response.headers.get('content-type') ?? '').toLowerCase().startsWith('text/')) {
      throw new PageRefused('page_not_text')
    }
    return readableText(await readBounded(response, this.maxBytes), this.maxTextChars)
  }
}
