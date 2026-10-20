import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { toolsetStoreContract } from '../ports/toolset-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgToolsetStore } from './pg-toolset-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

toolsetStoreContract('postgres', async () => ({
  store: new PgToolsetStore(db),
  newGuild: () => foundTestGuild(db, { name: 'Toolsets', goal: 'g' }),
}))
