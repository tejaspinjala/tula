import {
  createServer,
  type IncomingHttpHeaders,
  type IncomingMessage,
  request,
  type Server,
  type ServerResponse,
} from 'node:http'
import net from 'node:net'

/** Settings of the egress proxy. */
export interface EgressProxyOptions {
  /** Hosts a sandbox may reach: the model gateway and the MCP gateway, nothing else. */
  allowedHosts: readonly string[]
  /** Longest an upstream connection may take to open, in ms. Defaults to 5000. */
  connectTimeoutMs?: number
  /** Most simultaneous client connections. */
  maxConnections?: number
  /** A tunnel with no traffic for this long is closed, in ms. */
  tunnelIdleMs?: number
  /** A tunnel is closed after this long however busy, in ms. */
  tunnelMaxMs?: number
  /** Longest wait for an upstream response (a slow model reply), in ms. */
  responseIdleMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000

/** The host and port a proxy request names, or null when it does not parse. */
function target(raw: string, fallbackPort: number): { host: string; port: number } | null {
  try {
    const url = new URL(raw)
    if (url.username !== '' || url.password !== '') {
      return null
    }
    return { host: url.hostname.toLowerCase(), port: Number(url.port || fallbackPort) }
  } catch {
    return null
  }
}

/** Hop-by-hop headers belong to one connection and are not forwarded (RFC 9110 7.6.1). */
const HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

function withoutHopHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  return Object.fromEntries(Object.entries(headers).filter(([k]) => !HOP_HEADERS.has(k)))
}

/**
 * Builds the allowlisting egress proxy: the only way out of a sandbox. A request is forwarded
 * only when its host exactly equals an allowed host (no suffix or wildcard match, no userinfo);
 * anything else is answered `403` and never connects. It speaks plain HTTP forwarding and
 * CONNECT tunnels (for TLS), and holds no state. The allowlist is deterministic configuration,
 * never a model decision.
 */
export function createEgressProxy(options: EgressProxyOptions): Server {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()))
  const timeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS

  const deny = (res: ServerResponse): void => {
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
    res.end('egress_denied')
  }

  const forward = (req: IncomingMessage, res: ServerResponse): void => {
    const to = target(req.url ?? '', 80)
    if (to === null || !allowed.has(to.host)) {
      deny(res)
      return
    }
    const upstream = request(
      {
        host: to.host,
        port: to.port,
        method: req.method,
        path: new URL(req.url ?? '').pathname + new URL(req.url ?? '').search,
        headers: withoutHopHeaders(req.headers),
        timeout: timeoutMs,
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, withoutHopHeaders(reply.headers))
        reply.pipe(res)
      }
    )
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { connection: 'close' })
      res.end('egress_unreachable')
    })
    req.pipe(upstream)
  }

  const server = createServer(forward)
  server.on('connect', (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    const to = target(`http://${req.url ?? ''}`, 443)
    if (to === null || !allowed.has(to.host)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect({ host: to.host, port: to.port, timeout: timeoutMs }, () => {
      upstream.setTimeout(0)
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('timeout', () => upstream.destroy())
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'))
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })
  return server
}
