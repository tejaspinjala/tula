import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { guildMasterLookStoreContract } from '../ports/guild-master-look-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { PgGuildMasterLookStore } from './pg-guild-master-look-store'

const db = createDb(testDbUrl('app'))
afterAll(async () => {
  await db.close()
})

guildMasterLookStoreContract('postgres', async () => ({
  store: new PgGuildMasterLookStore(db),
  newGuild: () => foundTestGuild(db, { name: 'Looks', goal: 'g' }),
}))
