import { afterEach, describe, expect, test } from 'bun:test'
import { createServer, type Server } from 'node:http'
import net from 'node:net'
import { createEgressProxy } from './egress-proxy'

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

/** A plain upstream that answers every request with `upstream`. */
async function upstream(): Promise<number> {
  return listen(
    createServer((_req, res) => {
      res.end('upstream')
    })
  )
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
    setTimeout(() => socket.end(), 300)
  })
}

describe('egress proxy', () => {
  test('forwards a plain HTTP request to an allowed host', async () => {
    const target = await upstream()
    const proxy = await listen(createEgressProxy({ allowedHosts: ['127.0.0.1'] }))
    const reply = await raw(
      proxy,
      `GET http://127.0.0.1:${target}/x HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`
    )
    expect(reply).toContain('200')
    expect(reply).toContain('upstream')
  })

  test('refuses a plain HTTP request to a host off the allowlist', async () => {
    const target = await upstream()
    const proxy = await listen(createEgressProxy({ allowedHosts: ['gateway.internal'] }))
    const reply = await raw(
      proxy,
      `GET http://127.0.0.1:${target}/x HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\nConnection: close\r\n\r\n`
    )
    expect(reply).toContain('403')
    expect(reply).not.toContain('upstream')
  })

  test('tunnels CONNECT to an allowed host', async () => {
    const target = await upstream()
    const proxy = await listen(createEgressProxy({ allowedHosts: ['127.0.0.1'] }))
    const reply = await raw(
      proxy,
      `CONNECT 127.0.0.1:${target} HTTP/1.1\r\nHost: 127.0.0.1:${target}\r\n\r\n`,
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
    const proxy = await listen(createEgressProxy({ allowedHosts: ['gateway.internal'] }))
    const reply = await raw(proxy, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`)
    expect(reply.startsWith('HTTP/1.1 403')).toBe(true)
    expect(connections).toBe(0)
  })

  test('matches hosts exactly: a look-alike suffix or userinfo trick is refused', async () => {
    const target = await upstream()
    const proxy = await listen(createEgressProxy({ allowedHosts: ['127.0.0.1'] }))
    const suffix = await raw(
      proxy,
      `GET http://127.0.0.1.evil.test:${target}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    )
    const userinfo = await raw(
      proxy,
      `GET http://127.0.0.1@evil.test:${target}/ HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`
    )
    expect(suffix).toContain('403')
    expect(userinfo).toContain('403')
  })
})
