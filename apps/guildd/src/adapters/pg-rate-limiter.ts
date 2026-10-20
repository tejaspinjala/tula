import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import type { RateDecision, RateLimiter, RateRule } from '../ports/rate-limiter'

/** Windows that started longer ago than this are deleted; rule windows must be shorter. */
const PRUNE_AFTER_MS = 60 * 60 * 1000
/** Roughly one hit in this many also prunes, keeping the table small without a delete per hit. */
const PRUNE_ONE_IN = 100

/**
 * Postgres {@link RateLimiter}: one atomic upsert statement per hit in the shared `rate_limits`
 * table, so every instance of the app sees the same counts and nothing is kept in process memory.
 * About one hit in {@link PRUNE_ONE_IN} also deletes windows older than an hour. `random` is
 * injectable (a number in [0, 1)) so tests are deterministic.
 */
export class PgRateLimiter implements RateLimiter {
  constructor(
    private readonly db: Pick<Db, 'bumpRateLimit' | 'pruneRateLimits'>,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random
  ) {}

  async hit(bucket: string, rule: RateRule): Promise<RateDecision> {
    const now = this.clock.now().getTime()
    const start = Math.floor(now / rule.windowMs) * rule.windowMs
    const hits = await this.db.bumpRateLimit(bucket, new Date(start))
    if (this.random() < 1 / PRUNE_ONE_IN) {
      // Housekeeping only: a failed prune must not fail a hit that was already counted.
      await this.db.pruneRateLimits(new Date(start - PRUNE_AFTER_MS)).catch(() => undefined)
    }
    return {
      allowed: hits <= rule.limit,
      retryAfterSeconds: Math.max(1, Math.ceil((start + rule.windowMs - now) / 1000)),
    }
  }
}
