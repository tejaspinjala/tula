import { afterAll } from 'bun:test'
import postgres from 'postgres'
import { createDb } from '../db/client'
import { streamTicketContract } from '../ports/stream-ticket.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgStreamTicketStore } from './pg-stream-ticket-store'

const db = createDb(testDbUrl('app'))
const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
afterAll(async () => {
  await db.close()
  await owner.end()
})

streamTicketContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  return {
    store: new PgStreamTicketStore(db, clock, () => 0),
    stored: async (guildId: string) =>
      Number(
        (await owner`select count(*)::int as n from stream_tickets where guild_id = ${guildId}`)[0]
          ?.n
      ),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Tickets', goal: 'g' }),
  }
})
