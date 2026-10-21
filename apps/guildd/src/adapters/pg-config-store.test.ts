import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb, type TenantTx } from '../db/client'
import { defaultConfig } from '../guild-config'
import { configStoreContract } from '../ports/config-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgConfigStore } from './pg-config-store'
import { PgModelLedger } from './pg-model-ledger'
import { PgQuestQueue } from './pg-quest-queue'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

configStoreContract('postgres', async () => {
  const keys = new MemoryKeyProvider()
  const quests = new PgQuestQueue(db, keys, new MemoryClock(new Date()), () => 0.5)
  const ledger = new PgModelLedger(db, keys)
  return {
    store: new PgConfigStore(db, keys),
    newGuild: () => foundTestGuild(db, { name: 'Config', goal: 'g' }),
    activeQuest: async (guildId, hallId) => {
      const { quest } = await quests.post(guildId, {
        jobKey: `lock-${crypto.randomUUID()}`,
        templateId: 'herald-brief',
        hallId,
        rank: 'journeyman',
        dataClass: 'internal',
        title: 't',
        ownerId: 'heralds-member-2',
        doneCondition: 'c',
        roundLimit: 1,
      })
      await quests.claim(guildId, { leaseMs: 60_000, maxActive: 5, questId: quest.id })
      return {
        read: async () => {
          const q = await quests.get(guildId, quest.id)
          return {
            state: q?.state ?? 'missing',
            leaseExpiresAt: q?.leaseExpiresAt ?? null,
            attempts: q?.attempts ?? 0,
            refunds: q?.refunds ?? 0,
          }
        },
      }
    },
    liveRun: async (guildId, hallId) => {
      const runId = crypto.randomUUID()
      await ledger.openRun(guildId, {
        runId,
        questId: crypto.randomUUID(),
        attempt: 1,
        hallId,
        providerId: 'home',
        profileId: 'p',
        state: 'active',
        tokenHash: runId,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      })
      return { read: async () => (await ledger.getRun(guildId, runId))?.state ?? 'missing' }
    },
  }
})

describe('stored autonomous Seal Policy', () => {
  test('rows written before the lock still read, as always (applied and pending)', async () => {
    const store = new PgConfigStore(db, new MemoryKeyProvider())
    const guild = await foundTestGuild(db, { name: 'Legacy', goal: 'g' })
    await store.seed(guild)
    await db.withGuild(guild, async (tx) => {
      const doc = tx.json(
        JSON.parse(JSON.stringify({ ...defaultConfig(), sealPolicy: 'autonomous' }))
      )
      await tx`insert into guild_config_versions (guild_id, version, status, kind, change, base_version, config)
        values (${guild}, 2, 'applied', 'change', 'widening', 1, ${doc})`
      await tx`insert into guild_config_versions (guild_id, version, status, kind, change, base_version, config)
        values (${guild}, 3, 'pending', 'change', 'widening', 2, ${doc})`
    })
    expect((await store.current(guild)).config.sealPolicy).toBe('always')
    expect((await store.get(guild, 3))?.config.sealPolicy).toBe('always')
    const history = await store.history(guild, { limit: 10 })
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1])
  })
})

describe('stored duplicate provider ids', () => {
  test('a row written before the refusal still reads, deduplicated', async () => {
    const store = new PgConfigStore(db, new MemoryKeyProvider())
    const guild = await foundTestGuild(db, { name: 'Dups', goal: 'g' })
    await store.seed(guild)
    await db.withGuild(guild, async (tx) => {
      const doc = tx.json(
        JSON.parse(
          JSON.stringify({
            ...defaultConfig(),
            providers: [
              { id: 'home', auth: 'api_key', privateEligible: false },
              { id: 'home', auth: 'api_key', privateEligible: true },
            ],
          })
        )
      )
      await tx`insert into guild_config_versions (guild_id, version, status, kind, change, base_version, config)
        values (${guild}, 2, 'applied', 'change', 'widening', 1, ${doc})`
    })
    expect((await store.current(guild)).config.providers).toEqual([
      { id: 'home', auth: 'api_key', privateEligible: false },
    ])
  })
})

describe('config status guard', () => {
  async function guildWithPending() {
    const store = new PgConfigStore(db, new MemoryKeyProvider())
    const guild = await foundTestGuild(db, { name: 'Guard', goal: 'g' })
    await store.seed(guild)
    await store.propose(guild, { ...defaultConfig(), sealPolicy: 'routine_alone' })
    return guild
  }
  const attempt = (guild: string, run: (tx: TenantTx) => Promise<unknown>) =>
    db.withGuild(guild, run)

  test('the app role may move pending to applied only', async () => {
    const guild = await guildWithPending()
    await expect(
      attempt(
        guild,
        (tx) =>
          tx`update guild_config_versions set status = 'pending' where guild_id = ${guild} and version = 1`
      )
    ).rejects.toThrow()
    await attempt(
      guild,
      (tx) =>
        tx`update guild_config_versions set status = 'applied' where guild_id = ${guild} and version = 2`
    )
    await expect(
      attempt(
        guild,
        (tx) =>
          tx`update guild_config_versions set status = 'pending' where guild_id = ${guild} and version = 2`
      )
    ).rejects.toThrow()
  })

  test('config, change and base_version cannot be edited, even by the owner', async () => {
    const guild = await guildWithPending()
    const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
    const edit = async (column: 'change' | 'config' | 'base_version') =>
      owner.begin(async (tx) => {
        await tx`select set_config('app.guild_id', ${guild}, true)`
        if (column === 'change') {
          await tx`update guild_config_versions set change = 'neutral' where guild_id = ${guild} and version = 2`
        } else if (column === 'config') {
          await tx`update guild_config_versions set config = '{}'::jsonb where guild_id = ${guild} and version = 2`
        } else {
          await tx`update guild_config_versions set base_version = 99 where guild_id = ${guild} and version = 2`
        }
      })
    try {
      for (const column of ['change', 'config', 'base_version'] as const) {
        await expect(edit(column)).rejects.toThrow()
      }
    } finally {
      await owner.end()
    }
  })
})

describe('hall lock events', () => {
  const withLock = (id: string, locked: boolean) => {
    const base = defaultConfig()
    return { ...base, halls: base.halls.map((h) => (h.id === id ? { ...h, locked } : h)) }
  }
  const hallEvents = (guild: string) =>
    db.withGuild(guild, async (tx) =>
      (
        await tx`select type from events where guild_id = ${guild} and type like 'hall.%locked' order by seq`
      ).map((r) => String(r.type))
    )

  test('confirming an unlock and applying a re-lock each write exactly one event', async () => {
    const store = new PgConfigStore(db, new MemoryKeyProvider())
    const guild = await foundTestGuild(db, { name: 'Locks', goal: 'g' })
    await store.seed(guild)
    const pending = await store.propose(guild, withLock('health', false))
    expect(pending.status).toBe('pending')
    expect(await hallEvents(guild)).toEqual([])
    await store.confirm(guild, pending.version)
    expect(await hallEvents(guild)).toEqual(['hall.unlocked'])
    const relock = await store.propose(guild, withLock('health', true))
    expect(relock.status).toBe('applied')
    expect(await hallEvents(guild)).toEqual(['hall.unlocked', 'hall.locked'])
    await store.propose(guild, withLock('health', true))
    expect(await hallEvents(guild)).toEqual(['hall.unlocked', 'hall.locked'])
  })
})
