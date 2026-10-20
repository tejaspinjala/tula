import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { pushStoreContract } from '../ports/push-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgPushStore } from './pg-push-store'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

pushStoreContract('postgres', async () => ({
  store: new PgPushStore(db),
  newGuild: () => foundTestGuild(db, { name: 'Push', goal: 'g' }),
}))
