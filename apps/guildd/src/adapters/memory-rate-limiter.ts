import type { Clock } from '../ports/clock'
import type { RateDecision, RateLimiter, RateRule } from '../ports/rate-limiter'

/** In-memory {@link RateLimiter} for tests and development; counts live in this instance only. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, { start: number; hits: number }>()

  constructor(private readonly clock: Clock) {}

  // No await between reading and writing the count, so concurrent hits are counted atomically.
  async hit(bucket: string, rule: RateRule): Promise<RateDecision> {
    const now = this.clock.now().getTime()
    const start = Math.floor(now / rule.windowMs) * rule.windowMs
    const held = this.windows.get(bucket)
    const hits = held && held.start === start ? held.hits + 1 : 1
    this.windows.set(bucket, { start, hits })
    return {
      allowed: hits <= rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((start + rule.windowMs - now) / 1000)),
    }
  }
}
