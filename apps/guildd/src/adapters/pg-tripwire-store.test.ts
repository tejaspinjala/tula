import { afterAll } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { tripwireStoreContract } from '../ports/tripwire-store.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgTripwireStore } from './pg-tripwire-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

tripwireStoreContract('postgres', async () => ({
  store: new PgTripwireStore(
    db,
    new MemoryKeyProvider(),
    new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  ),
  newGuild: () => foundTestGuild(db, { name: 'Tripwires', goal: 'g' }),
  events: async (guildId: string) =>
    (
      await owner`
        select type from events where guild_id = ${guildId} and type like 'hall.%' order by seq`
    ).map((e) => String(e.type)),
}))
