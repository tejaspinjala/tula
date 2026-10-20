import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import type { RateLimiter } from './rate-limiter'

/** What a contract run needs: a fresh limiter and the clock it reads. */
export interface RateLimiterSubject {
  limiter: RateLimiter
  clock: MemoryClock
}

/** The RateLimiter contract, run against every adapter. */
export function rateLimiterContract(name: string, make: () => Promise<RateLimiterSubject>) {
  const rule = { limit: 3, windowMs: 60_000 }
  const bucket = () => `test:${crypto.randomUUID()}`

  describe(`RateLimiter contract: ${name}`, () => {
    test('allows up to the limit, then refuses with a positive retry-after', async () => {
      const { limiter } = await make()
      const b = bucket()
      for (let i = 0; i < rule.limit; i++) {
        expect((await limiter.hit(b, rule)).allowed).toBe(true)
      }
      const refused = await limiter.hit(b, rule)
      expect(refused.allowed).toBe(false)
      expect(refused.retryAfterSeconds).toBeGreaterThanOrEqual(1)
      expect(refused.retryAfterSeconds).toBeLessThanOrEqual(60)
    })

    test('buckets are independent', async () => {
      const { limiter } = await make()
      const a = bucket()
      for (let i = 0; i < rule.limit + 1; i++) {
        await limiter.hit(a, rule)
      }
      expect((await limiter.hit(bucket(), rule)).allowed).toBe(true)
    })

    test('a new window starts fresh', async () => {
      const { limiter, clock } = await make()
      const b = bucket()
      for (let i = 0; i < rule.limit + 1; i++) {
        await limiter.hit(b, rule)
      }
      clock.advance(rule.windowMs)
      expect((await limiter.hit(b, rule)).allowed).toBe(true)
    })

    test('retry-after counts down to the end of the window', async () => {
      const { limiter, clock } = await make()
      const b = bucket()
      for (let i = 0; i < rule.limit; i++) {
        await limiter.hit(b, rule)
      }
      const first = await limiter.hit(b, rule)
      clock.advance(30_000)
      const later = await limiter.hit(b, rule)
      expect(later.allowed).toBe(false)
      expect(later.retryAfterSeconds).toBeLessThan(first.retryAfterSeconds)
    })

    test('same-tick hits are counted atomically: exactly the limit are allowed', async () => {
      const { limiter } = await make()
      const b = bucket()
      const results = await Promise.all(
        Array.from({ length: rule.limit * 4 }, () => limiter.hit(b, rule))
      )
      expect(results.filter((r) => r.allowed)).toHaveLength(rule.limit)
    })
  })
}
