import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { researchStoreContract } from '../ports/research-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgResearchStore } from './pg-research-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

researchStoreContract('postgres', async () => ({
  store: new PgResearchStore(db),
  newGuild: () => foundTestGuild(db, { name: 'Research', goal: 'g' }),
}))
