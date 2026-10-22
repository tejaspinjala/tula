import { afterAll, describe, expect, test } from 'bun:test'
import { Hono } from 'hono'
import postgres from 'postgres'
import { z } from 'zod'
import { MemoryCharterImporter } from '../adapters/memory-charter-importer'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryConfigStore } from '../adapters/memory-config-store'
import { MemoryHandoffStore } from '../adapters/memory-handoff-store'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryProposalStore } from '../adapters/memory-proposal-store'
import { MemoryQuestQueue } from '../adapters/memory-quest-queue'
import { MemoryRiteStore } from '../adapters/memory-rite-store'
import { MemorySealStore } from '../adapters/memory-seal-store'
import { MemoryTripwireStore } from '../adapters/memory-tripwire-store'
import { PgCharterImporter } from '../adapters/pg-charter-importer'
import { PgConfigStore } from '../adapters/pg-config-store'
import { PgRiteStore } from '../adapters/pg-rite-store'
import { createDb, type TenantTx } from '../db/client'
import { defaultConfig, type GuildConfig } from '../guild-config'
import type { ConfigStore } from '../ports/config-store'
import type { NewRiteVersion, RiteStore, RiteVersion } from '../ports/rite-store'
import { ProposalEngine } from '../proposals'
import { RiteEngine } from '../rites/engine'
import { LEARNING_TO_LINKEDIN } from '../rites/templates'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { CHARTER_MAX_BYTES, exportCharter } from './charter'
import { CHARTER_EVENT } from './events'
import { mountCharterRoutes } from './routes'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))

/** A Pg Rite store whose Nth draft write throws, to prove the import is all or nothing. */
class FailingRiteStore extends PgRiteStore {
  writes = 0
  failOn = Number.POSITIVE_INFINITY
  override async saveVersionIn(
    tx: TenantTx,
    guildId: string,
    riteId: string,
    input: NewRiteVersion
  ): Promise<RiteVersion> {
    this.writes += 1
    if (this.writes >= this.failOn) {
      throw new Error('injected failure')
    }
    return super.saveVersionIn(tx, guildId, riteId, input)
  }
}

async function setup(kind: 'memory' | 'postgres') {
  const keys = new MemoryKeyProvider()
  const found = (name: string) =>
    kind === 'memory'
      ? Promise.resolve(crypto.randomUUID())
      : foundTestGuild(db, { name, goal: 'g' }, keys)
  const guild = await found('Acme')
  const other = await found('Other')
  let config: ConfigStore
  let store: RiteStore
  let failing: FailingRiteStore | null = null
  let imports: MemoryCharterImporter | PgCharterImporter
  if (kind === 'memory') {
    config = new MemoryConfigStore(clock)
    store = new MemoryRiteStore(clock)
    imports = new MemoryCharterImporter(config, store)
  } else {
    const pgConfig = new PgConfigStore(db, keys, clock)
    failing = new FailingRiteStore(db, keys, clock)
    config = pgConfig
    store = failing
    imports = new PgCharterImporter(db, keys, pgConfig, failing, clock)
  }
  await config.seed(guild)
  await config.seed(other)
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
  mountCharterRoutes(app, {
    rites: engine,
    config,
    clock,
    imports,
    namesDisabledSubscription: () => false,
    guildName: async () => 'Acme',
    recordExported: async () => {},
    // Auth and cross-guild behaviour through real sessions is tested in routes.app.test.ts.
    guildMasterSessionFor: async (c) => ({ guild: c.req.param('id') ?? '' }),
  })
  const post = (id: string, body: unknown) =>
    app.request(`/guilds/${id}/charter/import`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })
  const importedEvents = async (id: string): Promise<number> => {
    if (imports instanceof MemoryCharterImporter) {
      return imports.events.filter((e) => e.guildId === id && e.type === CHARTER_EVENT.imported)
        .length
    }
    const rows =
      await owner`select 1 from events where guild_id = ${id} and type = ${CHARTER_EVENT.imported}`
    return rows.length
  }
  const riteCount = async (id: string): Promise<number> => {
    const page = await engine.list(id, { limit: 100 })
    return page.rites.length
  }
  return { guild, other, config, store, engine, failing, post, importedEvents, riteCount, keys }
}

/** A Charter over `config` carrying the named Rites (each with an active manual-trigger graph). */
function charterOf(config: GuildConfig, riteNames: string[] = []) {
  return exportCharter({
    name: 'Source',
    config,
    rites: riteNames.map((name, i) => ({
      id: `src-${i}`,
      name,
      archivedAt: null,
      activeGraph: LEARNING_TO_LINKEDIN,
    })),
    now: clock.now(),
  })
}

function tightened(): GuildConfig {
  const c = defaultConfig()
  return { ...c, caps: { ...c.caps, dailyTokens: 500_000 } }
}

function widened(): GuildConfig {
  const c = defaultConfig()
  return { ...c, caps: { ...c.caps, dailyTokens: 2_000_000 } }
}

const resultBody = z.object({
  config: z.object({
    outcome: z.enum(['applied', 'pending', 'unchanged']),
    version: z.number(),
  }),
  riteIds: z.array(z.string()),
})

for (const kind of ['memory', 'postgres'] as const) {
  describe(`charter import on the ${kind} adapters`, () => {
    test('a tightening config is applied at once and the Rites arrive as drafts', async () => {
      const { guild, config, store, post, importedEvents } = await setup(kind)
      const res = await post(guild, {
        charter: charterOf(tightened(), ['One', 'Two']),
        baseVersion: 1,
        importId: 'imp-1',
      })
      expect(res.status).toBe(200)
      const body = resultBody.parse(await res.json())
      expect(body.config).toEqual({ outcome: 'applied', version: 2 })
      expect(body.riteIds).toHaveLength(2)
      expect((await config.current(guild)).config.caps.dailyTokens).toBe(500_000)
      for (const id of body.riteIds) {
        const v = await store.getVersion(guild, id)
        expect(v?.status).toBe('draft')
      }
      expect(await importedEvents(guild)).toBe(1)
    })

    test('a widening config stays pending and the version in force does not move', async () => {
      const { guild, config, post } = await setup(kind)
      const res = await post(guild, {
        charter: charterOf(widened()),
        baseVersion: 1,
        importId: 'w',
      })
      expect(res.status).toBe(200)
      expect(resultBody.parse(await res.json()).config).toEqual({ outcome: 'pending', version: 2 })
      expect((await config.current(guild)).version).toBe(1)
      await config.confirm(guild, 2)
      expect((await config.current(guild)).config.caps.dailyTokens).toBe(2_000_000)
    })

    test('an identical config is unchanged and writes no config version, yet the Rites still arrive', async () => {
      const { guild, config, post, riteCount } = await setup(kind)
      const res = await post(guild, {
        charter: charterOf(defaultConfig(), ['Only']),
        baseVersion: 1,
        importId: 'same',
      })
      const body = resultBody.parse(await res.json())
      expect(body.config).toEqual({ outcome: 'unchanged', version: 1 })
      expect(body.riteIds).toHaveLength(1)
      expect((await config.history(guild, { limit: 10 })).versions).toHaveLength(1)
      expect(await riteCount(guild)).toBe(1)
    })

    test("the importing guild's learningRepos and privateEligible survive", async () => {
      const { guild, config, post } = await setup(kind)
      const held = defaultConfig()
      const first = held.halls[0]
      expect(first).toBeDefined()
      const mine: GuildConfig = {
        ...held,
        learningRepos: ['acme/notes'],
        halls: held.halls.map((h) => (h.id === first?.id ? { ...h, privateEligible: true } : h)),
      }
      const proposed = await config.propose(guild, mine, { baseVersion: 1 })
      if (proposed.status === 'pending') {
        await config.confirm(guild, proposed.version)
      }
      const base = (await config.current(guild)).version
      const res = await post(guild, {
        charter: charterOf(tightened()),
        baseVersion: base,
        importId: 'local',
      })
      expect(res.status).toBe(200)
      const now = (await config.current(guild)).config
      expect(now.learningRepos).toEqual(['acme/notes'])
      expect(now.halls.find((h) => h.id === first?.id)?.privateEligible).toBe(true)
      expect(now.caps.dailyTokens).toBe(500_000)
    })

    test('a moved baseVersion is 409 stale and nothing is written', async () => {
      const { guild, config, post, importedEvents, riteCount } = await setup(kind)
      const res = await post(guild, {
        charter: charterOf(tightened(), ['One']),
        baseVersion: 7,
        importId: 'old',
      })
      expect(res.status).toBe(409)
      expect(await res.json()).toEqual({ error: 'stale' })
      expect((await config.current(guild)).version).toBe(1)
      expect(await riteCount(guild)).toBe(0)
      expect(await importedEvents(guild)).toBe(0)
    })

    test('a body over the byte cap is 413 and an invalid Charter is 422 invalid_charter', async () => {
      const { guild, post, importedEvents } = await setup(kind)
      const huge = await post(guild, ' '.repeat(CHARTER_MAX_BYTES + 4096))
      expect(huge.status).toBe(413)
      const bad = await post(guild, { charter: { nope: true }, baseVersion: 1, importId: 'bad' })
      expect(bad.status).toBe(422)
      expect(await bad.json()).toEqual({ error: 'invalid_charter' })
      expect(await importedEvents(guild)).toBe(0)
    })

    test('a retried importId returns the first result and writes nothing', async () => {
      const { guild, config, post, importedEvents, riteCount } = await setup(kind)
      const body = { charter: charterOf(tightened(), ['One']), baseVersion: 1, importId: 'again' }
      const first = resultBody.parse(await (await post(guild, body)).json())
      const second = await post(guild, body)
      expect(second.status).toBe(200)
      expect(resultBody.parse(await second.json())).toEqual(first)
      expect((await config.current(guild)).version).toBe(2)
      expect(await riteCount(guild)).toBe(1)
      expect(await importedEvents(guild)).toBe(1)
    })

    test('an import into one guild leaves another untouched, and the same importId there is its own', async () => {
      const { guild, other, config, post, riteCount } = await setup(kind)
      const body = { charter: charterOf(tightened(), ['One']), baseVersion: 1, importId: 'shared' }
      await post(guild, body)
      expect((await config.current(other)).version).toBe(1)
      expect(await riteCount(other)).toBe(0)
      const there = resultBody.parse(await (await post(other, body)).json())
      expect(there.config).toEqual({ outcome: 'applied', version: 2 })
      expect(await riteCount(other)).toBe(1)
    })

    test('imported Rites are drafts that never run', async () => {
      const { guild, engine, post } = await setup(kind)
      const res = await post(guild, {
        charter: charterOf(defaultConfig(), ['One']),
        baseVersion: 1,
        importId: 'norun',
      })
      const [riteId] = resultBody.parse(await res.json()).riteIds
      expect(riteId).toBeDefined()
      const run = await engine.run(guild, riteId ?? '', {})
      expect(run.ok).toBe(false)
      const pinned = await engine.run(guild, riteId ?? '', { version: 1 })
      expect(pinned).toMatchObject({ ok: false, error: 'version_not_active' })
    })
  })
}

describe('charter import atomicity on Postgres', () => {
  test('a failure while writing Rites leaves config, Rites, events and the idempotency record untouched', async () => {
    const { guild, config, failing, post, importedEvents, riteCount } = await setup('postgres')
    if (!failing) {
      throw new Error('postgres setup has a failing store')
    }
    failing.failOn = 2
    const res = await post(guild, {
      charter: charterOf(tightened(), ['One', 'Two']),
      baseVersion: 1,
      importId: 'boom',
    })
    expect(res.status).toBe(500)
    expect((await config.current(guild)).version).toBe(1)
    expect(await riteCount(guild)).toBe(0)
    expect(await importedEvents(guild)).toBe(0)
    const rows = await owner`select 1 from charter_imports where guild_id = ${guild}`
    expect(rows).toHaveLength(0)
    const configEvents = await owner`
      select 1 from events where guild_id = ${guild} and type = 'config.version_proposed'`
    expect(configEvents).toHaveLength(0)

    failing.failOn = Number.POSITIVE_INFINITY
    const retry = await post(guild, {
      charter: charterOf(tightened(), ['One', 'Two']),
      baseVersion: 1,
      importId: 'boom',
    })
    expect(retry.status).toBe(200)
  })
})

describe('charter_imports row security', () => {
  test("one guild cannot read or write another's import records", async () => {
    const { guild, other, post } = await setup('postgres')
    await post(guild, { charter: charterOf(tightened()), baseVersion: 1, importId: 'rls' })
    const seen = await db.withGuild(
      other,
      (tx) => tx`select import_id from charter_imports where guild_id = ${guild}`
    )
    expect(seen).toHaveLength(0)
    const own = await db.withGuild(
      guild,
      (tx) => tx`select import_id from charter_imports where guild_id = ${guild}`
    )
    expect(own).toHaveLength(1)
    await expect(
      db.withGuild(
        other,
        (tx) =>
          tx`insert into charter_imports (guild_id, import_id, result) values (${guild}, 'x', '{}'::jsonb)`
      )
    ).rejects.toThrow()
  })
})
