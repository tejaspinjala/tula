import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { routingLogContract } from '../ports/routing-log.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgRoutingLog } from './pg-routing-log'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

routingLogContract('postgres', async () => ({
  log: new PgRoutingLog(db),
  newGuild: () => foundTestGuild(db, { name: 'Routing', goal: 'g' }),
}))
