import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { streamTicketContract } from '../ports/stream-ticket.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgStreamTicketStore } from './pg-stream-ticket-store'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

streamTicketContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  return {
    store: new PgStreamTicketStore(db, clock),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Tickets', goal: 'g' }),
  }
})
