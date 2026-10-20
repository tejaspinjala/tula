import { afterAll, describe, expect, test } from 'bun:test'
import { createApp, websocket } from './app'
import { createDb, type Db } from './db/client'
import { appendEvent } from './events'
import { createHarness } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())
const { db } = harness.adapters

type Frame = { type: string; event?: { seq: number } }

const wsOpen = (url: string, guild: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-guild-id': guild } } as never)
    ws.onmessage = () => resolve(ws)
    ws.onerror = () => reject(new Error('socket error'))
  })

/** An app over a Db that counts stream fetches, with the fallback poll effectively off. */
function countingApp(extra: { maxSocketsPerGuild?: number } = {}) {
  const real = createDb(harness.appUrl)
  const counts = { stream: 0 }
  const counting: Db = {
    ...real,
    withGuildStream: (g, fn) => {
      counts.stream++
      return real.withGuildStream(g, fn)
    },
  }
  const app = createApp({
    clock: harness.adapters.clock,
    db: counting,
    objectStore: harness.adapters.objectStore,
    devGuildHeader: true,
    eventPollMs: 600_000,
    ...extra,
  })
  const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
  return {
    counts,
    app,
    base: `ws://localhost:${server.port}`,
    close: async () => {
      await server.stop(true)
      await real.close()
    },
  }
}

describe('event stream fan-out', () => {
  test('idle sockets beyond the HTTP pool size do not starve other routes', async () => {
    const s = countingApp()
    const sockets: WebSocket[] = []
    try {
      for (let g = 0; g < 3; g++) {
        const id = await db.foundGuild({ name: `G${g}`, goal: 'g' })
        for (let i = 0; i < 5; i++) {
          sockets.push(await wsOpen(`${s.base}/guilds/${id}/events`, id))
        }
      }
      expect(sockets.length).toBeGreaterThan(10)
      const started = performance.now()
      const health = await s.app.request('/health')
      const founded = await s.app.request('/guilds', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Late', goal: 'g' }),
      })
      expect(health.status).toBe(200)
      expect(founded.status).toBe(201)
      expect(performance.now() - started).toBeLessThan(500)
    } finally {
      for (const ws of sockets) {
        ws.close()
      }
      await s.close()
    }
  })

  test('one notify costs one fetch for the guild, however many sockets listen', async () => {
    const s = countingApp()
    const id = await db.foundGuild({ name: 'Fan', goal: 'g' })
    const received: number[][] = []
    const sockets: WebSocket[] = []
    try {
      for (let i = 0; i < 8; i++) {
        const seen: number[] = []
        received.push(seen)
        const ws = await wsOpen(`${s.base}/guilds/${id}/events?last_seq=1`, id)
        ws.onmessage = (m) => {
          const f = JSON.parse(String(m.data)) as Frame
          if (f.type === 'event' && f.event) {
            seen.push(f.event.seq)
          }
        }
        sockets.push(ws)
      }
      await Bun.sleep(100)
      const before = s.counts.stream
      await db.withGuild(id, (tx) => appendEvent(tx, 'test.fan', {}))
      await Bun.sleep(300)
      expect(received).toEqual(Array.from({ length: 8 }, () => [2]))
      expect(s.counts.stream - before).toBeLessThanOrEqual(2)
    } finally {
      for (const ws of sockets) {
        ws.close()
      }
      await s.close()
    }
  })

  test('a socket over the per-guild cap is refused with 429', async () => {
    const s = countingApp({ maxSocketsPerGuild: 2 })
    const id = await db.foundGuild({ name: 'Cap', goal: 'g' })
    const sockets: WebSocket[] = []
    try {
      for (let i = 0; i < 2; i++) {
        sockets.push(await wsOpen(`${s.base}/guilds/${id}/events`, id))
      }
      const res = await fetch(`${s.base.replace('ws', 'http')}/guilds/${id}/events`, {
        headers: { 'x-guild-id': id },
      })
      expect(res.status).toBe(429)
    } finally {
      for (const ws of sockets) {
        ws.close()
      }
      await s.close()
    }
  })
})
