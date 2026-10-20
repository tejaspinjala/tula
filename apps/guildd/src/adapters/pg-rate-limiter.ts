import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import type { RateDecision, RateLimiter, RateRule } from '../ports/rate-limiter'

/** Windows that ended longer ago than this are deleted; rule windows must be shorter. */
const PRUNE_AFTER_MS = 60 * 60 * 1000

/**
 * Postgres {@link RateLimiter}: one atomic upsert per hit in the shared `rate_limits` table, so
 * every instance of the app sees the same counts and nothing is kept in process memory.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  async hit(bucket: string, rule: RateRule): Promise<RateDecision> {
    const now = this.clock.now().getTime()
    const start = Math.floor(now / rule.windowMs) * rule.windowMs
    const hits = await this.db.bumpRateLimit(
      bucket,
      new Date(start),
      new Date(start - PRUNE_AFTER_MS)
    )
    return {
      allowed: hits <= rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((start + rule.windowMs - now) / 1000)),
    }
  }
}
