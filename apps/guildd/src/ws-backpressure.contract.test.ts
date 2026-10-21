import { afterAll, describe, expect, test } from 'bun:test'
import { createApp, websocket } from './app'
import { createDb } from './db/client'
import { appendEvent } from './events'
import { createHarness, UNLIMITED_RATE_LIMITS } from './testing/harness'
import { assertBackpressureSupported, readBufferedAmount } from './ws-support'

const harness = await createHarness()
afterAll(() => harness.close())
const { db, keys } = harness.adapters

describe('websocket backpressure', () => {
  test('the Bun runtime exposes getBufferedAmount on a real server socket', async () => {
    await expect(assertBackpressureSupported()).resolves.toBeUndefined()
  })

  test('a handle without getBufferedAmount reads as unknown, never as empty', () => {
    expect(readBufferedAmount({})).toBeNull()
    expect(readBufferedAmount(undefined)).toBeNull()
    expect(readBufferedAmount({ getBufferedAmount: () => 7 })).toBe(7)
  })

  test('a hung stream query is cancelled by the stream pool statement timeout', async () => {
    const id = await harness.foundGuild({ name: 'Hung', goal: 'g' })
    const streamDb = createDb(harness.appUrl, { streamStatementTimeoutMs: 200 })
    try {
      const started = performance.now()
      await expect(
        streamDb.withGuildStream(id, async (tx) => {
          await tx`select pg_sleep(5)`
        })
      ).rejects.toThrow(/statement timeout/)
      expect(performance.now() - started).toBeLessThan(3000)
    } finally {
      await streamDb.close()
    }
  })

  test('a real consumer that falls behind is closed with 1013', async () => {
    const id = await harness.foundGuild({ name: 'Backed', goal: 'g' })
    const big = 'x'.repeat(2 * 1024 * 1024)
    await db.withGuild(id, async (tx) => {
      await appendEvent(tx, keys, 'test.big', { big })
      await appendEvent(tx, keys, 'test.big', { big })
      await appendEvent(tx, keys, 'test.big', { big })
    })
    const app = createApp({
      clock: harness.adapters.clock,
      db,
      objectStore: harness.adapters.objectStore,
      anchor: harness.adapters.anchor,
      identity: harness.adapters.identity,
      seals: harness.adapters.seals,
      tripwires: harness.adapters.tripwires,
      treasury: harness.adapters.treasury,
      learning: harness.adapters.learning,
      proposals: harness.adapters.proposals,
      workflows: harness.adapters.workflows,
      rateLimiter: harness.adapters.rateLimiter,
      rateLimits: UNLIMITED_RATE_LIMITS,
      secrets: harness.adapters.secrets,
      config: harness.adapters.config,
      notes: harness.adapters.notes,
      missives: harness.adapters.missives,
      inquiries: harness.adapters.inquiries,
      dossiers: harness.adapters.dossiers,
      dossierStore: harness.adapters.dossierStore,
      quests: harness.adapters.quests,
      mcp: harness.adapters.mcp,
      streamTickets: harness.adapters.streamTickets,
      pushStore: harness.adapters.pushStore,
      guildMasterLooks: harness.adapters.guildMasterLooks,
      pushNotifier: harness.adapters.pushNotifier,
      pushRelay: harness.adapters.pushRelay,
      vapidPublicKey: null,
      classifier: harness.adapters.classifier,
      routingLog: harness.adapters.routingLog,
      gateway: harness.adapters.gateway,
      gates: harness.adapters.gates,
      sandboxes: harness.adapters.sandboxes,
      summon: harness.adapters.summon,
      dispatcher: harness.adapters.dispatcher,
      sealStore: harness.adapters.sealStore,
      modelLedger: harness.adapters.modelLedger,
      postCosts: harness.adapters.postCosts,
      platformOperators: [],
      keys,
      devGuildHeader: true,
      eventPollMs: 600_000,
      maxSocketBufferBytes: 1,
    })
    const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
    try {
      const code = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${server.port}/guilds/${id}/events?last_seq=1`, {
          headers: { 'x-guild-id': id },
        })
        ws.onclose = (e) => resolve(e.code)
        ws.onerror = () => reject(new Error('socket error'))
      })
      expect(code).toBe(1013)
    } finally {
      await server.stop(true)
    }
  })
})
