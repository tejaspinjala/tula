import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { createEgressProxy, type EgressProxyOptions } from './egress-proxy'

const open: Array<{ close: () => void }> = []
afterEach(() => {
  for (const s of open.splice(0)) {
    s.close()
  }
})

function listen(server: Server): Promise<number> {
  open.push(server)
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (address === null || typeof address === 'string') {
        reject(new Error('no port'))
        return
      }
      resolve(address.port)
    })
  })
}

/** A plain upstream that answers every request with `upstream`, after `delayMs`. */
async function upstream(delayMs = 0, seen?: { host?: string | undefined }): Promise<number> {
  return listen(
    createServer((req, res) => {
      if (seen) {
        seen.host = req.headers.host
      }
      setTimeout(() => res.end('upstream'), delayMs)
    })
  )
}

/** A proxy allowing exactly `127.0.0.1:<port>` for each port given. */
function proxyFor(ports: number[], extra: Partial<EgressProxyOptions> = {}): Promise<number> {
  return listen(createEgressProxy({ allowedHosts: ports.map((p) => `127.0.0.1:${p}`), ...extra }))
}

/** Sends a raw request through the proxy and returns everything it answers until close. */
function raw(proxyPort: number, request: string, afterHead?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1')
    let data = ''
    socket.setEncoding('utf8')
    socket.on('data', (chunk: string) => {
      data += chunk
      if (afterHead !== undefined && data.includes('\r\n\r\n') && data.startsWith('HTTP/1.1 200')) {
        socket.write(afterHead)
        afterHead = undefined
      }
    })
    socket.on('error', reject)
    socket.on('close', () => resolve(data))
    socket.write(request)
    setTimeout(() => socket.end(), 1500)
  })
}

const get = (host: string, port: number, hostHeader = `${host}:${port}`) =>
  `GET http://${host}:${port}/x HTTP/1.1\r\nHost: ${hostHeader}\r\nConnection: close\r\n\r\n`

describe('egress proxy', () => {
  test('forwards a plain HTTP request to an allowed host and port', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target])
    const reply = await raw(proxy, get('127.0.0.1', target))
    expect(reply).toContain('200')
    expect(reply).toContain('upstream')
  })

  test('refuses a plain HTTP request to a host off the allowlist', async () => {
    const target = await upstream()
    const proxy = await listen(createEgressProxy({ allowedHosts: ['gateway.internal:80'] }))
    const reply = await raw(proxy, get('127.0.0.1', target))
    expect(reply).toContain('403')
    expect(reply).not.toContain('upstream')
  })

  test('tunnels CONNECT to an allowed host and port', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target])
    const reply = await raw(
      proxy,
      `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: x\r\n\r\n`,
      'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'
    )
    expect(reply.startsWith('HTTP/1.1 200')).toBe(true)
    expect(reply).toContain('upstream')
  })

  test('refuses CONNECT to a host off the allowlist without opening a connection', async () => {
    let connections = 0
    const target = createServer()
    target.on('connection', () => {
      connections += 1
    })
    const port = await listen(target)
    const proxy = await listen(createEgressProxy({ allowedHosts: ['gateway.internal:80'] }))
    const reply = await raw(proxy, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true)
    expect(connections).toBe(0)
  })

  test('an allowed host on any other port is refused, for CONNECT and plain HTTP, with no upstream socket', async () => {
    let connections = 0
    const other = createServer()
    other.on('connection', () => {
      connections += 1
    })
    const otherPort = await listen(other)
    const allowedPort = await upstream()
    const proxy = await proxyFor([allowedPort])
    const tunnel = await raw(proxy, `CONNECT 127.0.0.1:${otherPort} HTTP/1.1\r\nHost: x\r\n\r\n`)
    const plain = await raw(proxy, get('127.0.0.1', otherPort))
    expect(tunnel.startsWith('HTTP/1.1 403')).toBe(true)
    expect(plain).toContain('403')
    expect(connections).toBe(0)
  })

  test('matches hosts exactly: a look-alike suffix or userinfo trick is refused', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target])
    const suffix = await raw(proxy, get('127.0.0.1.evil.test', target))
    const userinfo = await raw(
      proxy,
      `GET http://127.0.0.1@evil.test:${target}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    )
    expect(suffix).toContain('403')
    expect(userinfo).toContain('403')
  })

  test('the upstream sees the allowed authority, whatever Host header the client sent', async () => {
    const seen: { host?: string | undefined } = {}
    const target = await upstream(0, seen)
    const proxy = await proxyFor([target])
    await raw(proxy, get('127.0.0.1', target, 'evil.example'))
    expect(seen.host).toBe(`127.0.0.1:${target}`)
  })

  test('refuses connection N+1 beyond maxConnections', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target], { maxConnections: 1 })
    const held = net.connect(proxy, '127.0.0.1')
    await new Promise((r) => held.once('connect', r))
    open.push({ close: () => held.destroy() })
    const second = await new Promise<string>((resolve) => {
      const s = net.connect(proxy, '127.0.0.1')
      s.on('error', () => resolve('refused'))
      s.on('close', () => resolve('refused'))
      s.on('data', () => resolve('served'))
      s.write(get('127.0.0.1', target))
      setTimeout(() => resolve('served'), 1500)
    })
    expect(second).toBe('refused')
  })

  test('closes a tunnel that goes idle', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target], { tunnelIdleMs: 200 })
    const started = Date.now()
    const reply = await raw(proxy, `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: x\r\n\r\n`)
    expect(reply.startsWith('HTTP/1.1 200')).toBe(true)
    expect(Date.now() - started).toBeLessThan(1400)
  })

  test('closes a tunnel that outlives its total lifetime even while busy', async () => {
    const target = await upstream()
    const proxy = await proxyFor([target], { tunnelIdleMs: 5_000, tunnelMaxMs: 300 })
    const closedAt = await new Promise<number>((resolve) => {
      const started = Date.now()
      const s = net.connect(proxy, '127.0.0.1')
      s.write(`CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: x\r\n\r\n`)
      const keepBusy = setInterval(() => s.write('x'), 50)
      s.on('error', () => {})
      s.on('close', () => {
        clearInterval(keepBusy)
        resolve(Date.now() - started)
      })
    })
    expect(closedAt).toBeLessThan(2000)
  })

  test('a reply slower than the connect timeout still succeeds within the response timeout', async () => {
    const target = await upstream(700)
    const proxy = await proxyFor([target], { connectTimeoutMs: 200, responseIdleMs: 5_000 })
    const reply = await raw(proxy, get('127.0.0.1', target))
    expect(reply).toContain('upstream')
  })

  test('closing the client closes the upstream side of a tunnel', async () => {
    let upstreamClosed = false
    const target = createServer()
    target.on('connection', (s) => s.on('close', () => (upstreamClosed = true)))
    const port = await listen(target)
    const proxy = await proxyFor([port])
    await new Promise<void>((resolve) => {
      const s = net.connect(proxy, '127.0.0.1')
      s.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)
      s.once('data', () => {
        s.destroy()
        resolve()
      })
    })
    await Bun.sleep(300)
    expect(upstreamClosed).toBe(true)
  })
})
