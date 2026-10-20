import { afterAll, describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { createApp, websocket } from './app'
import { createDb, type Db } from './db/client'
import { createEventHub } from './event-hub'
import { appendEvent } from './events'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'

const harness = await createHarness()
afterAll(() => harness.close())
const { db, keys } = harness.adapters

const FrameSchema = z.object({ type: z.string(), event: z.object({ seq: z.number() }).optional() })

const wsOpen = (url: string, guild: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-guild-id': guild } })
    ws.onmessage = () => resolve(ws)
    ws.onerror = () => reject(new Error('socket error'))
  })

/** An app over a Db that counts stream fetches, with the fallback poll effectively off. */
function countingApp(
  extra: { maxSocketsPerGuild?: number; eventPollMs?: number; maxSocketBufferBytes?: number } = {}
) {
  const real = createDb(harness.appUrl)
  const counts = { stream: 0, http: 0 }
  const counting: Db = {
    ...real,
    withGuild: (g, fn) => {
      counts.http++
      return real.withGuild(g, fn)
    },
    withGuildStream: (g, fn) => {
      counts.stream++
      return real.withGuildStream(g, fn)
    },
  }
  const app = createApp({
    clock: harness.adapters.clock,
    db: counting,
    objectStore: harness.adapters.objectStore,
    anchor: harness.adapters.anchor,
    identity: harness.adapters.identity,
    seals: harness.adapters.seals,
    tripwires: harness.adapters.tripwires,
    proposals: harness.adapters.proposals,
    rateLimiter: harness.adapters.rateLimiter,
    rateLimits: UNLIMITED_RATE_LIMITS,
    secrets: harness.adapters.secrets,
    config: harness.adapters.config,
    notes: harness.adapters.notes,
    quests: harness.adapters.quests,
    mcp: harness.adapters.mcp,
    streamTickets: harness.adapters.streamTickets,
    classifier: harness.adapters.classifier,
    routingLog: harness.adapters.routingLog,
    gateway: harness.adapters.gateway,
    keys,
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
    const s = countingApp({ eventPollMs: 50 })
    const sockets: WebSocket[] = []
    try {
      for (let g = 0; g < 3; g++) {
        const id = await harness.foundGuild({ name: `G${g}`, goal: 'g' })
        for (let i = 0; i < 5; i++) {
          sockets.push(await wsOpen(`${s.base}/guilds/${id}/events`, id))
        }
      }
      expect(sockets.length).toBeGreaterThan(10)
      // Idle sockets must not touch the pool that serves HTTP, even across many fallback polls.
      const httpBefore = s.counts.http
      await Bun.sleep(300)
      expect(s.counts.http - httpBefore).toBe(0)
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
    const id = await harness.foundGuild({ name: 'Fan', goal: 'g' })
    const received: number[][] = []
    const sockets: WebSocket[] = []
    try {
      for (let i = 0; i < 8; i++) {
        const seen: number[] = []
        received.push(seen)
        const ws = await wsOpen(`${s.base}/guilds/${id}/events?last_seq=1`, id)
        ws.onmessage = (m) => {
          const f = FrameSchema.parse(JSON.parse(String(m.data)))
          if (f.type === 'event' && f.event) {
            seen.push(f.event.seq)
          }
        }
        sockets.push(ws)
      }
      await Bun.sleep(100)
      const before = s.counts.stream
      await db.withGuild(id, (tx) => appendEvent(tx, keys, 'test.fan', {}))
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
    const id = await harness.foundGuild({ name: 'Cap', goal: 'g' })
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

  test('a refused upgrade over the stream cap does not spend the ticket', async () => {
    const s = countingApp({ maxSocketsPerGuild: 1 })
    const id = await harness.foundGuild({ name: 'Burn', goal: 'g' })
    const open = await wsOpen(`${s.base}/guilds/${id}/events`, id)
    try {
      const { ticket } = await harness.adapters.streamTickets.issue(id)
      const refused = await s.app.request(`/guilds/${id}/events?ticket=${ticket}`, {
        headers: { upgrade: 'websocket' },
      })
      expect(refused.status).toBe(429)
      expect(await harness.adapters.streamTickets.consume(id, ticket)).toBe(true)
    } finally {
      open.close()
      await s.close()
    }
  })

  test('simultaneous upgrades over the cap never admit more than the cap', async () => {
    const s = countingApp({ maxSocketsPerGuild: 3 })
    const id = await harness.foundGuild({ name: 'Race', goal: 'g' })
    const sockets: WebSocket[] = []
    try {
      const outcomes = await Promise.all(
        Array.from(
          { length: 10 },
          () =>
            new Promise<'open' | 'refused'>((resolve) => {
              const ws = new WebSocket(`${s.base}/guilds/${id}/events`, {
                headers: { 'x-guild-id': id },
              })
              sockets.push(ws)
              ws.onmessage = () => resolve('open')
              ws.onerror = () => resolve('refused')
            })
        )
      )
      expect(outcomes.filter((o) => o === 'open').length).toBe(3)
      expect(outcomes.filter((o) => o === 'refused').length).toBe(7)
    } finally {
      for (const ws of sockets) {
        ws.close()
      }
      await s.close()
    }
  })

  test('a slow consumer whose buffer exceeds the threshold is closed with 1013', async () => {
    const hubDb = createDb(harness.appUrl)
    const id = await harness.foundGuild({ name: 'Slow', goal: 'g' })
    const hub = createEventHub(hubDb, { pollMs: 600_000, maxBufferedBytes: 1000 })
    const closed: Array<[number, string]> = []
    const sent: string[] = []
    const sub = hub.subscribe(id, 0, {
      send: (d) => sent.push(d),
      bufferedAmount: () => 5000,
      close: (code, reason) => closed.push([code, reason]),
    })
    try {
      sub.start()
      await Bun.sleep(300)
      expect(closed).toEqual([[1013, 'consumer too slow']])
      expect(sent).toEqual([])
    } finally {
      sub.unsubscribe()
      await hubDb.close()
    }
  })
})
