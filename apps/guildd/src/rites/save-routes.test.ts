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
import type { RiteStore } from '../ports/rite-store'
import { ProposalEngine } from '../proposals'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { RiteEngine } from './engine'
import { RITE_EVENT_PREFIX } from './events'
import { mountRiteRoutes } from './routes'
import { LEARNING_TO_LINKEDIN } from './templates'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))

/** Two guilds on the chosen adapter, with the Rite routes mounted and the session guard stubbed. */
async function setup(kind: 'memory' | 'postgres') {
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
  const app = new Hono()
  const guard = async (c: { req: { param: (k: string) => string | undefined } }) => ({
    guild: c.req.param('id') ?? '',
  })
  mountRiteRoutes(app, {
    rites: engine,
    identity: {
      resolveSession: async () => ({ guildId: guild, memberId: 'm', role: 'guild_master' }),
      consumeReauth: async () => true,
    },
    sessionGuildFor: guard,
    guildMasterSessionFor: guard,
  })
  const put = (id: string, body: unknown) =>
    app.request(`/guilds/${id}/rites/wf`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const versions = async (id: string) =>
    (await engine.versions(id, 'wf', { limit: 100 })).versions.length
  const riteEvents = async (id: string) =>
    kind === 'memory'
      ? 0
      : Number(
          (
            await owner`select count(*)::int as n from events where guild_id = ${id} and type like ${`${RITE_EVENT_PREFIX}%`}`
          )[0]?.n
        )
  return { engine, guild, other, put, versions, riteEvents }
}

for (const kind of ['memory', 'postgres'] as const) {
  describe(`Rite saves on the ${kind} adapters`, () => {
    test('saving the newest version unchanged writes no version and no event', async () => {
      const { guild, put, versions, riteEvents } = await setup(kind)
      const first = await put(guild, { name: 'Flow', graph: LEARNING_TO_LINKEDIN })
      const events = await riteEvents(guild)
      const again = await put(guild, { name: 'Flow', graph: LEARNING_TO_LINKEDIN })
      expect(again.status).toBe(200)
      expect(await again.json()).toEqual(await first.json())
      expect(await versions(guild)).toBe(1)
      expect(await riteEvents(guild)).toBe(events)
      const renamed = await put(guild, { name: 'Flow 2', graph: LEARNING_TO_LINKEDIN })
      expect(await renamed.json()).toMatchObject({ version: { version: 2 } })
    })

    test('saving the active version unchanged reports it active, not a draft', async () => {
      const { engine, guild, put, versions } = await setup(kind)
      await put(guild, { name: 'Flow', graph: LEARNING_TO_LINKEDIN })
      await engine.publish(guild, 'wf', 1, null)
      await engine.confirm(guild, 'wf', 1)
      const again = await put(guild, { name: 'Flow', graph: LEARNING_TO_LINKEDIN })
      expect(await again.json()).toMatchObject({ status: 'active', version: { version: 1 } })
      expect(await versions(guild)).toBe(1)
    })

    test('a save id replayed with a different name or graph is 409 save_id_reused', async () => {
      const { guild, put, versions } = await setup(kind)
      await put(guild, { name: 'A', graph: LEARNING_TO_LINKEDIN, saveId: 's1' })
      const renamed = await put(guild, { name: 'B', graph: LEARNING_TO_LINKEDIN, saveId: 's1' })
      expect(renamed.status).toBe(409)
      expect(await renamed.json()).toEqual({ error: 'save_id_reused' })
      const same = await put(guild, { name: 'A', graph: LEARNING_TO_LINKEDIN, saveId: 's1' })
      expect(same.status).toBe(200)
      expect(await versions(guild)).toBe(1)
    })

    test('a repeated save id returns the first result and writes nothing', async () => {
      const { guild, put, versions } = await setup(kind)
      const first = await put(guild, { name: 'A', graph: LEARNING_TO_LINKEDIN, saveId: 's1' })
      const firstBody: unknown = await first.json()
      await put(guild, { name: 'B', graph: LEARNING_TO_LINKEDIN, saveId: 's2' })
      const repeat = await put(guild, { name: 'A', graph: LEARNING_TO_LINKEDIN, saveId: 's1' })
      expect(await repeat.json()).toEqual(firstBody)
      expect(await versions(guild)).toBe(2)
    })

    test('a save id from another guild cannot collide', async () => {
      const { guild, other, put, versions } = await setup(kind)
      await put(guild, { name: 'A', graph: LEARNING_TO_LINKEDIN, saveId: 'same' })
      const res = await put(other, { name: 'Other', graph: LEARNING_TO_LINKEDIN, saveId: 'same' })
      expect(await res.json()).toMatchObject({ version: { name: 'Other', version: 1 } })
      expect(await versions(other)).toBe(1)
      expect(await versions(guild)).toBe(1)
    })
  })
}
