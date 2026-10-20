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
  /**
   * The `host:port` pairs a sandbox may reach: the model gateway and the MCP gateway, nothing
   * else. Any other host, or the same host on another port, is refused.
   */
  allowedHosts: readonly string[]
  /** Longest an upstream connection may take to open, in ms. Defaults to 5000. */
  connectTimeoutMs?: number
  /** Most simultaneous client connections. Defaults to 256. */
  maxConnections?: number
  /** A tunnel with no traffic for this long is closed, in ms. Defaults to 120000. */
  tunnelIdleMs?: number
  /** A tunnel is closed after this long however busy, in ms. Defaults to 900000. */
  tunnelMaxMs?: number
  /** Longest wait for an upstream response (a slow model reply), in ms. Defaults to 120000. */
  responseIdleMs?: number
}

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_CONNECTIONS = 256
const DEFAULT_TUNNEL_IDLE_MS = 120_000
const DEFAULT_TUNNEL_MAX_MS = 900_000
const DEFAULT_RESPONSE_IDLE_MS = 120_000

/** The host and port a proxy request names, or null when it does not parse. */
function target(raw: string): { host: string; port: number } | null {
  try {
    const url = new URL(raw)
    if (url.username !== '' || url.password !== '') {
      return null
    }
    return {
      host: url.hostname.toLowerCase(),
      port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
    }
  } catch {
    return null
  }
}

/**
 * The target of a CONNECT request: its authority must carry an explicit port. Parsing it as an
 * http URL would turn `host:80` into the scheme default (an empty port), so a default is never
 * guessed; plain proxy requests use the absolute URI's own scheme default (http 80, https 443).
 */
function tunnelTarget(authority: string): { host: string; port: number } | null {
  const match = /^([a-z0-9.-]+):([0-9]{1,5})$/i.exec(authority)
  const port = Number(match?.[2])
  return match?.[1] && port >= 1 && port <= 65535 ? { host: match[1].toLowerCase(), port } : null
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
 * only when its host and port exactly equal an allowed `host:port` (no suffix or wildcard match,
 * no userinfo); anything else is answered `403` and never connects. The upstream `Host` header is
 * always the allowed authority, whatever the client sent. It speaks plain HTTP forwarding and
 * CONNECT tunnels (for TLS), bounds connections, tunnel idle time and tunnel lifetime, and holds
 * no state. The allowlist is deterministic configuration, never a model decision.
 */
export function createEgressProxy(options: EgressProxyOptions): Server {
  const allowed = new Set(options.allowedHosts.map((h) => h.toLowerCase()))
  const permits = (to: { host: string; port: number }): boolean =>
    allowed.has(`${to.host}:${to.port}`)
  const connectMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
  const responseMs = options.responseIdleMs ?? DEFAULT_RESPONSE_IDLE_MS
  const idleMs = options.tunnelIdleMs ?? DEFAULT_TUNNEL_IDLE_MS
  const maxMs = options.tunnelMaxMs ?? DEFAULT_TUNNEL_MAX_MS

  const deny = (res: ServerResponse): void => {
    res.writeHead(403, { 'content-type': 'text/plain', connection: 'close' })
    res.end('egress_denied')
  }

  const forward = (req: IncomingMessage, res: ServerResponse): void => {
    const to = target(req.url ?? '')
    if (to === null || !permits(to)) {
      deny(res)
      return
    }
    const url = new URL(req.url ?? '')
    const upstream = request(
      {
        host: to.host,
        port: to.port,
        method: req.method,
        path: url.pathname + url.search,
        headers: { ...withoutHopHeaders(req.headers), host: `${to.host}:${to.port}` },
      },
      (reply) => {
        res.writeHead(reply.statusCode ?? 502, withoutHopHeaders(reply.headers))
        reply.pipe(res)
      }
    )
    // Opening the connection is bounded tightly; waiting for the reply (a model call) much longer.
    const connectTimer = setTimeout(() => upstream.destroy(), connectMs)
    upstream.on('socket', (socket) => {
      const opened = () => {
        clearTimeout(connectTimer)
        socket.setTimeout(responseMs, () => upstream.destroy())
      }
      if (socket.connecting) {
        socket.once('connect', opened)
      } else {
        opened()
      }
    })
    upstream.on('close', () => clearTimeout(connectTimer))
    upstream.on('error', () => {
      if (res.headersSent) {
        res.destroy()
        return
      }
      res.writeHead(502, { connection: 'close' })
      res.end('egress_unreachable')
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  const server = createServer(forward)
  server.maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS
  server.on('connect', (req: IncomingMessage, socket: net.Socket, head: Buffer) => {
    const to = tunnelTarget(req.url ?? '')
    if (to === null || !permits(to)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nconnection: close\r\n\r\n')
      return
    }
    const upstream = net.connect({ host: to.host, port: to.port, timeout: connectMs }, () => {
      upstream.setTimeout(idleMs)
      socket.setTimeout(idleMs)
      const lifetime = setTimeout(() => {
        upstream.destroy()
        socket.destroy()
      }, maxMs)
      upstream.on('close', () => clearTimeout(lifetime))
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('timeout', () => {
      upstream.destroy()
      socket.destroy()
    })
    socket.on('timeout', () => {
      upstream.destroy()
      socket.destroy()
    })
    upstream.on('error', () => socket.end('HTTP/1.1 502 Bad Gateway\r\nconnection: close\r\n\r\n'))
    upstream.on('close', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })
  return server
}
