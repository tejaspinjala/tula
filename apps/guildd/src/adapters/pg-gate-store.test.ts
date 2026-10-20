import { afterAll } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { gateStoreContract } from '../ports/gate-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgGateStore } from './pg-gate-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

gateStoreContract('postgres', async () => ({
  store: new PgGateStore(db, new MemoryKeyProvider()),
  newGuild: () => foundTestGuild(db, { name: 'Gates', goal: 'g' }),
  events: async (guildId: string) =>
    (
      await owner`
        select type from events where guild_id = ${guildId} and type like 'gates.%' order by seq`
    ).map((e) => String(e.type)),
}))
