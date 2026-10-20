import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { configStoreContract } from '../ports/config-store.contract'
import { testDbUrl } from '../testing/test-db'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgConfigStore } from './pg-config-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

configStoreContract('postgres', async () => ({
  store: new PgConfigStore(db, new MemoryKeyProvider()),
  newGuild: () => db.foundGuild({ name: 'Config', goal: 'g' }),
}))
