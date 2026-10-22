import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import postgres from 'postgres'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryRiteStore } from '../adapters/memory-rite-store'
import { MemorySealStore } from '../adapters/memory-seal-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { PgRiteStore } from '../adapters/pg-rite-store'
import { createDb } from '../db/client'
import { appendEvent } from '../events'
import type { RiteStore } from '../ports/rite-store'
import { ProposalEngine } from '../proposals'
import { RiteEngine } from '../rites/engine'
import { LEARNING_TO_LINKEDIN } from '../rites/templates'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { CHARTER_MAX_RITES, charterSchema } from './charter'
import { CHARTER_EVENT } from './events'
import { type CharterExportedFact, mountCharterRoutes } from './routes'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))

/** A guild on the chosen adapters, with the session guard stubbed to pass. */
async function setup(kind: 'memory' | 'postgres', maxBytes?: number) {
  const keys = new MemoryKeyProvider()
  const found = (name: string) =>
    kind === 'memory'
      ? Promise.resolve(crypto.randomUUID())
      : foundTestGuild(db, { name, goal: 'g' }, keys)
  const guild = await found('Acme')
  const other = await found('Other')
  const config = new MemoryConfigStore(clock)
  await config.seed(guild)
  await config.seed(other)
  const store: RiteStore =
    kind === 'memory' ? new MemoryRiteStore(clock) : new PgRiteStore(db, keys, clock)
  const engine = new RiteEngine({
    store,
    config,
    quests: new MemoryQuestQueue(clock, () => 0.5),
    tripwires: new MemoryTripwireStore(clock),
    proposals: new ProposalEngine({ store: new MemoryProposalStore(clock), config }),
    seals: new MemorySealStore(clock),
    handoffs: new MemoryHandoffStore(),
  })
  const memoryEvents: { guild: string; fact: CharterExportedFact }[] = []
  const app = new Hono()
  mountCharterRoutes(app, {
    rites: engine,
    config,
    clock,
    guildName: async (id) => (id === guild ? 'Acme' : id === other ? 'Other' : null),
    recordExported: async (id, fact) => {
      if (kind === 'memory') {
        memoryEvents.push({ guild: id, fact })
        return
      }
      await db.withGuild(id, (tx) => appendEvent(tx, keys, CHARTER_EVENT.exported, fact))
    },
    // Auth and cross-guild behaviour is tested through the composed app (routes.app.test.ts).
    guildMasterSessionFor: async (c) => ({ guild: c.req.param('id') ?? '' }),
    ...(maxBytes === undefined ? {} : { maxBytes }),
  })
  const events = async (id: string): Promise<string[]> => {
    if (kind === 'memory') {
      return memoryEvents.filter((e) => e.guild === id).map(() => CHARTER_EVENT.exported)
    }
    const rows =
      await owner`select type from events where guild_id = ${id} and type = ${CHARTER_EVENT.exported}`
    return rows.map((r) => String(r.type))
  }
  const get = (id: string, token?: string) =>
    app.request(
      `/guilds/${id}/charter`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {}
    )
  return { engine, guild, other, get, events }
}

for (const kind of ['memory', 'postgres'] as const) {
  describe(`charter export on the ${kind} adapters`, () => {
    test('the Guild Master gets a bare Charter with the active Rites, others omitted, and an event', async () => {
      const { engine, guild, get, events } = await setup(kind)
      for (const id of ['live', 'gone']) {
        await engine.save(guild, id, {
          name: id === 'live' ? 'Live' : 'Gone',
          graph: LEARNING_TO_LINKEDIN,
        })
        await engine.publish(guild, id, 1, null)
        await engine.confirm(guild, id, 1)
      }
      await engine.archive(guild, 'gone')
      await engine.save(guild, 'draft', { name: 'Draft', graph: LEARNING_TO_LINKEDIN })

      const res = await get(guild, 'master')
      expect(res.status).toBe(200)
      const charter = charterSchema.parse(await res.json())
      expect(charter.name).toBe('Acme')
      expect(charter.exportedAt).toBe('2030-01-01T00:00:00.000Z')
      expect(charter.rites.map((r) => r.name)).toEqual(['Live'])
      const omittedRites = charter.omitted
        .filter((o) => o.kind === 'rite')
        .map((o) => [o.id, o.reason])
        .sort()
      expect(omittedRites).toEqual([
        ['draft', 'unpublished'],
        ['gone', 'archived'],
      ])
      expect(await events(guild)).toEqual([CHARTER_EVENT.exported])
    })

    test('more than the Rite limit exports the first by name then id and omits the rest as over_limit', async () => {
      const { engine, guild, get } = await setup(kind)
      for (let i = 0; i < CHARTER_MAX_RITES + 1; i++) {
        const id = `r${String(i).padStart(3, '0')}`
        await engine.save(guild, id, { name: 'same', graph: LEARNING_TO_LINKEDIN })
        await engine.publish(guild, id, 1, null)
        await engine.confirm(guild, id, 1)
      }
      const res = await get(guild, 'master')
      expect(res.status).toBe(200)
      const charter = charterSchema.parse(await res.json())
      expect(charter.rites).toHaveLength(CHARTER_MAX_RITES)
      expect(charter.omitted).toContainEqual({ kind: 'rite', id: 'r050', reason: 'over_limit' })
    })

    test('a document over the byte limit is 413 charter_too_large and records no event', async () => {
      const { guild, get, events } = await setup(kind, 100)
      const res = await get(guild, 'master')
      expect(res.status).toBe(413)
      expect(await res.json()).toEqual({ error: 'charter_too_large' })
      expect(await events(guild)).toEqual([])
    })
  })
}
