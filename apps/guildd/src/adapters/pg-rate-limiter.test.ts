import { afterAll } from 'bun:test'
import { createDb } from '../db/client'
import { rateLimiterContract } from '../ports/rate-limiter.contract'
import { testDbUrl } from '../testing/test-db'
import { MemoryClock } from './memory-clock'
import { PgRateLimiter } from './pg-rate-limiter'

const db = createDb(testDbUrl('app'))
afterAll(() => db.close())

rateLimiterContract('postgres', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  return { limiter: new PgRateLimiter(db, clock), clock }
})
