import { rateLimiterContract } from '../ports/rate-limiter.contract'
import { MemoryClock } from './memory-clock'
import { MemoryRateLimiter } from './memory-rate-limiter'

rateLimiterContract('memory', async () => {
  const clock = new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))
  return { limiter: new MemoryRateLimiter(clock), clock }
})
