import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { loadEnv } from './env'
import { withWebApp } from './web-static'

const root = mkdtempSync(join(tmpdir(), 'guildhall-web-'))
const dist = join(root, 'dist')
const secret = join(root, 'secret.txt')

const api = new Hono()
api.get('/health', (c) => c.json({ status: 'ok' }))
api.get('/guilds/:id', (c) => c.json({ guild: c.req.param('id') }))

const html = '<!doctype html><title>Guildhall</title>'
const app = withWebApp(api, dist)

beforeAll(() => {
  mkdirSync(join(dist, 'assets'), { recursive: true })
  writeFileSync(join(dist, 'index.html'), html)
  writeFileSync(join(dist, 'assets', 'index-abc123.js'), 'console.log(1)')
  writeFileSync(join(dist, 'assets', 'index-abc123.css'), 'a{}')
  writeFileSync(join(dist, 'icon.svg'), '<svg/>')
  writeFileSync(secret, 'nope')
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

const asBrowser = { headers: { accept: 'text/html' } }

describe('withWebApp', () => {
  test('serves the API both under /api and un-prefixed', async () => {
    for (const path of ['/api/health', '/health', '/api/guilds/g1']) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain('application/json')
    }
    expect(await (await app.request('/api/guilds/g1')).json()).toEqual({ guild: 'g1' })
  })

  test('a SPA deep link falls back to index.html with security headers', async () => {
    const res = await app.request('/guilds/g1/quests', asBrowser)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe(html)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(res.headers.get('cache-control')).toBe('no-cache')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'")
    expect(res.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('referrer-policy')).toBe('no-referrer')
  })

  test('an API call to a deep path still reaches the API', async () => {
    const res = await app.request('/guilds/g1')
    expect(await res.json()).toEqual({ guild: 'g1' })
  })

  test('serves assets with content types and immutable caching', async () => {
    const js = await app.request('/assets/index-abc123.js')
    expect(js.headers.get('content-type')).toContain('javascript')
    expect(js.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    const css = await app.request('/assets/index-abc123.css')
    expect(css.headers.get('content-type')).toContain('text/css')
    const svg = await app.request('/icon.svg')
    expect(svg.headers.get('content-type')).toContain('image/svg+xml')
    expect(svg.headers.get('cache-control')).not.toContain('immutable')
  })

  test('refuses path traversal, plain and encoded', async () => {
    for (const path of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/assets/..%2f..%2fsecret.txt',
      '/assets/%2e%2e/%2e%2e/secret.txt',
      '/%00',
    ]) {
      const res = await app.request(path, asBrowser)
      const body = await res.text()
      expect(body).not.toContain('nope')
      // The URL parser may normalise a plain `..`; then the SPA shell is all that can come back.
      expect(res.status === 404 || body === html).toBe(true)
    }
  })

  test('a missing asset is 404, not index.html', async () => {
    const res = await app.request('/assets/missing.js')
    expect(res.status).toBe(404)
  })
})

describe('WEB_DIST in loadEnv', () => {
  const base = {
    APP_DATABASE_URL: 'postgres://app:pw@localhost:5432/db',
    OBJECT_STORE_ACCESS_KEY: 'access',
    OBJECT_STORE_SECRET_KEY: 'secret',
  }

  test('is optional', () => {
    expect(loadEnv(base).WEB_DIST).toBeUndefined()
  })

  test('accepts a directory that holds index.html', () => {
    expect(loadEnv({ ...base, WEB_DIST: dist }).WEB_DIST).toBe(dist)
  })

  test('fails clearly when the directory is missing or has no index.html', () => {
    expect(() => loadEnv({ ...base, WEB_DIST: join(root, 'nope') })).toThrow(/WEB_DIST/)
    expect(() => loadEnv({ ...base, WEB_DIST: join(dist, 'assets') })).toThrow(/index\.html/)
  })
})
