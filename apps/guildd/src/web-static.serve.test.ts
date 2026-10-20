import { afterAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { createBunWebSocket } from 'hono/bun'
import { z } from 'zod'
import { withWebApp } from './web-static'

// Through a real Bun server: Bun can only upgrade, or report the address of, the Request it
// handed to fetch, so `/api` must reach the API with that same Request.
const dist = mkdtempSync(join(tmpdir(), 'guildhall-web-serve-'))
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>Guildhall</title>')

const { upgradeWebSocket, websocket } = createBunWebSocket()
const api = new Hono()
api.get('/ip', (c) => {
  // Called on the server object, as the rate limiter does: requestIP needs its `this`.
  const env: unknown = c.env
  const info: unknown =
    typeof env === 'object' &&
    env !== null &&
    'requestIP' in env &&
    typeof env.requestIP === 'function'
      ? env.requestIP(c.req.raw)
      : null
  const address = z.object({ address: z.string() }).safeParse(info)
  return c.json({ address: address.success ? address.data.address : null })
})
api.get(
  '/ws',
  upgradeWebSocket(() => ({
    onOpen: (_event, ws) => ws.send('hello'),
  })),
  (c) => c.json({ error: 'upgrade_required' }, 426)
)

const server = Bun.serve({ port: 0, fetch: withWebApp(api, dist).fetch, websocket })
afterAll(() => {
  server.stop(true)
  rmSync(dist, { recursive: true, force: true })
})

test('an /api request still carries the client address', async () => {
  const res = await fetch(`http://localhost:${server.port}/api/ip`)
  expect(await res.json()).toEqual({ address: expect.stringMatching(/127\.0\.0\.1|::1/) })
})

test('a WebSocket upgrades through /api', async () => {
  const ws = new WebSocket(`ws://localhost:${server.port}/api/ws`)
  const first = await new Promise<string>((resolve, reject) => {
    ws.onmessage = (event) => resolve(String(event.data))
    ws.onerror = () => reject(new Error('websocket failed'))
    setTimeout(() => reject(new Error('no message within 2 s')), 2000)
  })
  ws.close()
  expect(first).toBe('hello')
})
