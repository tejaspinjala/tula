/** A fixed-window rule: at most `limit` hits per `windowMs`. */
export interface RateRule {
  limit: number
  windowMs: number
}

/** Outcome of one {@link RateLimiter.hit}. */
export interface RateDecision {
  /** False once the bucket has taken more than `rule.limit` hits in the current window. */
  allowed: boolean
  /** Whole seconds until the window rolls over (at least 1); what `Retry-After` carries. */
  retryAfterSeconds: number
}

/**
 * Port for abuse limits on unauthenticated routes. State lives in the adapter's shared store, never
 * in process memory of the app, so every instance sees the same counts. Buckets are opaque keys
 * (a client address, a guild id); this is not tenant data.
 */
export interface RateLimiter {
  /**
   * Counts one hit against `bucket` and says whether it is within `rule`. Concurrent hits are
   * counted atomically: with a limit of N, exactly N of any number of same-moment hits are allowed.
   * Hits over the limit still count, so a client that keeps retrying stays blocked for the window.
   */
  hit(bucket: string, rule: RateRule): Promise<RateDecision>
}
