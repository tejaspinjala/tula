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
import { charterSchema } from './charter'
import { CHARTER_EVENT } from './events'
import { type CharterExportedFact, mountCharterRoutes } from './routes'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))

/** Two guilds on one store; the guard mirrors the app's: 401 anonymous, 404 other guild, 403 non-master. */
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
  const memoryEvents: { guild: string; fact: CharterExportedFact }[] = []
  const app = new Hono()
  const principals: Record<string, { guild: string; role: string }> = {
    master: { guild, role: 'guild_master' },
    member: { guild, role: 'member' },
    otherMaster: { guild: other, role: 'guild_master' },
  }
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
    guildMasterSessionFor: async (c) => {
      const token = c.req.header('authorization')?.replace('Bearer ', '')
      const who = token ? principals[token] : undefined
      if (!who) {
        return { res: c.json({ error: 'unauthenticated' }, 401) }
      }
      if (who.guild !== c.req.param('id')) {
        return { res: c.json({ error: 'not_found' }, 404) }
      }
      return who.role === 'guild_master'
        ? { guild: who.guild }
        : { res: c.json({ error: 'forbidden' }, 403) }
    },
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

    test('anonymous is 401 and a member is 403, with no event', async () => {
      const { guild, get, events } = await setup(kind)
      expect((await get(guild)).status).toBe(401)
      expect((await get(guild, 'member')).status).toBe(403)
      expect(await events(guild)).toEqual([])
    })

    test('the Guild Master of another guild cannot export this one', async () => {
      const { guild, other, get, events } = await setup(kind)
      expect((await get(guild, 'otherMaster')).status).toBe(404)
      expect(await events(guild)).toEqual([])
      expect(await events(other)).toEqual([])
    })
  })
}
