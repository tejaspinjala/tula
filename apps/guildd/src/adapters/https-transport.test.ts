import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHttpsTransport } from './http-page-fetcher'

// The REAL transport, driven against a local TLS server whose certificate is for `pin.test`
// only. The transport is pinned to 127.0.0.1; the private-address check lives in the fetcher
// above it, so calling the transport directly is the explicit test seam.
let dir = ''
let cert = ''
let server: Server
let port = 0
const hosts: Array<string | undefined> = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pin-test-'))
  const key = join(dir, 'key.pem')
  const crt = join(dir, 'cert.pem')
  const made = Bun.spawnSync([
    'openssl',
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-keyout',
    key,
    '-out',
    crt,
    '-days',
    '1',
    '-subj',
    '/CN=pin.test',
    '-addext',
    'subjectAltName=DNS:pin.test',
  ])
  if (made.exitCode !== 0) {
    throw new Error('openssl could not make the test certificate')
  }
  cert = readFileSync(crt, 'utf8')
  server = createServer({ key: readFileSync(key, 'utf8'), cert }, (req, res) => {
    hosts.push(req.headers.host)
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('pinned hello')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const bound = server.address()
  if (bound === null || typeof bound === 'string') {
    throw new Error('test server did not bind a port')
  }
  port = bound.port
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(dir, { recursive: true, force: true })
})

const signal = () => new AbortController().signal

describe('createHttpsTransport (real node:https)', () => {
  test('connects to the pinned address, sends the name as Host and SNI, and reads the body', async () => {
    const transport = createHttpsTransport({ ca: cert })
    const response = await transport({
      url: `https://pin.test:${port}/page`,
      address: '127.0.0.1',
      family: 4,
      signal: signal(),
    })
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('pinned hello')
    expect(hosts.at(-1)).toBe(`pin.test:${port}`)
  })

  test('a certificate for another name fails the TLS check', async () => {
    const transport = createHttpsTransport({ ca: cert })
    const failure = await transport({
      url: `https://other.test:${port}/page`,
      address: '127.0.0.1',
      family: 4,
      signal: signal(),
    }).catch((e: unknown) => e)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).toMatchObject({ code: 'ERR_TLS_CERT_ALTNAME_INVALID' })
  })
})
