import { afterAll, describe, expect, test } from 'bun:test'
import postgres from 'postgres'
import { createDb, type TenantTx } from '../db/client'
import { defaultConfig } from '../guild-config'
import { configStoreContract } from '../ports/config-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgConfigStore } from './pg-config-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

configStoreContract('postgres', async () => ({
  store: new PgConfigStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Config', goal: 'g' }),
}))

describe('stored autonomous Seal Policy', () => {
  test('rows written before the lock still read, as always (applied and pending)', async () => {
    const store = new PgConfigStore(db, new MemoryKeyProvider())
    const guild = await foundTestGuild(db, { name: 'Legacy', goal: 'g' })
    await store.seed(guild)
    const doc = JSON.stringify({ ...defaultConfig(), sealPolicy: 'autonomous' })
    await db.withGuild(guild, async (tx) => {
      await tx`insert into guild_config_versions (guild_id, version, status, kind, change, base_version, config)
        values (${guild}, 2, 'applied', 'change', 'widening', 1, ${doc}::jsonb)`
      await tx`insert into guild_config_versions (guild_id, version, status, kind, change, base_version, config)
        values (${guild}, 3, 'pending', 'change', 'widening', 2, ${doc}::jsonb)`
    })
    expect((await store.current(guild)).config.sealPolicy).toBe('always')
    expect((await store.get(guild, 3))?.config.sealPolicy).toBe('always')
    const history = await store.history(guild, { limit: 10 })
    expect(history.versions.map((v) => v.version)).toEqual([3, 2, 1])
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
