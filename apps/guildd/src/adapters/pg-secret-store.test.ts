import { afterAll, expect, test } from 'bun:test'
import postgres from 'postgres'
import { z } from 'zod'
import { createDb } from '../db/client'
import { secretStoreContract } from '../ports/secret-store.contract'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgSecretStore } from './pg-secret-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

const sealedRow = z.object({ sealed: z.instanceof(Uint8Array) })

async function stored(guildId: string, ref: string): Promise<Uint8Array | null> {
  const rows =
    await owner`select sealed from vault_secrets where guild_id = ${guildId} and ref = ${ref}`
  return rows[0] ? sealedRow.parse(rows[0]).sealed : null
}

secretStoreContract('postgres', async () => ({
  store: new PgSecretStore(db, new MemoryKeyProvider()),
  newGuild: () => db.foundGuild({ name: 'Vault', goal: 'g' }),
  stored,
}))

test('the data key is stored wrapped, and a different KeyProvider cannot decrypt', async () => {
  const guild = await db.foundGuild({ name: 'Vault', goal: 'g' })
  const store = new PgSecretStore(db, new MemoryKeyProvider())
  await store.add(guild, 'openai', 'sk-wrapped-check')
  const [row] = await owner`select wrapped_key from vault_keys where guild_id = ${guild}`
  expect(row?.wrapped_key.length).toBeGreaterThan(32)
  const stranger = new PgSecretStore(db, new MemoryKeyProvider())
  await expect(stranger.resolve(guild, 'openai')).rejects.toThrow()
})

test('adding a secret appends an event carrying the ref and never the value', async () => {
  const guild = await db.foundGuild({ name: 'Vault', goal: 'g' })
  await new PgSecretStore(db, new MemoryKeyProvider()).add(guild, 'openai', 'sk-event-leak')
  const events =
    await owner`select type, payload from events where guild_id = ${guild} order by seq`
  const added = events.filter((e) => e.type === 'vault.secret_added')
  expect(added.map((e) => e.payload)).toEqual([{ ref: 'openai' }])
  expect(JSON.stringify(events)).not.toContain('sk-event-leak')
})
