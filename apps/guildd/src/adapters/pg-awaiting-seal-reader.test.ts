import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { awaitingSealReaderContract } from '../ports/awaiting-seal-reader.contract'
import { foundTestGuild } from '../testing/found-guild'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { MemoryKeyProvider } from './memory-key-provider'
import { PgAwaitingSealReader } from './pg-awaiting-seal-reader'
import { PgQuestQueue } from './pg-quest-queue'
import { PgSealStore } from './pg-seal-store'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

awaitingSealReaderContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const keys = new MemoryKeyProvider()
  return {
    reader: new PgAwaitingSealReader(db, clock),
    quests: new PgQuestQueue(db, keys, clock, () => 0.5),
    seals: new PgSealStore(db, keys, clock),
    clock,
    newGuild: () => foundTestGuild(db, { name: 'Awaiting', goal: 'g' }),
  }
})
