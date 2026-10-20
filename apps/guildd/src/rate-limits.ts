import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { clientAddress } from './client-ip'
import type { RateLimiter, RateRule } from './ports/rate-limiter'

/** The unauthenticated identity routes that are rate limited. */
export type RateRoute = 'signin-begin' | 'passkeys-begin' | 'passkeys-finish' | 'founding'

/** Limits for one route: per client address, and (for guild routes) per guild across all clients. */
export interface RouteLimits {
  client: RateRule
  guild?: RateRule
}

/** Per-route limits; see {@link DEFAULT_RATE_LIMITS}. */
export type RateLimits = Record<RateRoute, RouteLimits>

const MINUTE = 60_000

/**
 * Default limits, per minute. The per-guild limit is a ceiling across all clients and so also
 * bounds a distributed flood of one guild; it is set well above a person's use because it is
 * also the most an attacker can spend to lock the Guild Master out of sign-in for a minute.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = {
  'signin-begin': {
    client: { limit: 30, windowMs: MINUTE },
    guild: { limit: 120, windowMs: MINUTE },
  },
  'passkeys-begin': {
    client: { limit: 30, windowMs: MINUTE },
    guild: { limit: 120, windowMs: MINUTE },
  },
  'passkeys-finish': {
    client: { limit: 30, windowMs: MINUTE },
    guild: { limit: 120, windowMs: MINUTE },
  },
  founding: { client: { limit: 10, windowMs: MINUTE } },
}

const socketInfo = z.object({ address: z.string() })

/**
 * The peer address of the TCP connection, which a client cannot forge. Bun passes its server as
 * the request's `env`; calls made without a socket (in-process tests) have none.
 */
function socketAddress(c: Context): string | undefined {
  const env: unknown = c.env
  if (typeof env !== 'object' || env === null || !('requestIP' in env)) {
    return undefined
  }
  if (typeof env.requestIP !== 'function') {
    return undefined
  }
  const info: unknown = env.requestIP(c.req.raw)
  const parsed = socketInfo.safeParse(info)
  return parsed.success ? parsed.data.address : undefined
}

/**
 * Middleware that counts the request against the client bucket (and the guild bucket, when the
 * route has a valid `:id` guild) and answers 429 with `Retry-After` once either is exhausted.
 * The client address comes from {@link clientAddress}: the socket peer, or the last
 * `X-Forwarded-For` hop only when `trustProxy` (env `TRUST_PROXY`) is set.
 */
export function rateLimit(
  limiter: RateLimiter,
  route: RateRoute,
  limits: RouteLimits,
  trustProxy: boolean
): MiddlewareHandler {
  return async (c, next) => {
    const client = clientAddress({
      socket: socketAddress(c),
      forwardedFor: c.req.header('x-forwarded-for'),
      trustProxy,
    })
    const decisions = [await limiter.hit(`${route}:ip:${client}`, limits.client)]
    const guild = z.uuid().safeParse(c.req.param('id'))
    if (limits.guild && guild.success) {
      decisions.push(await limiter.hit(`${route}:guild:${guild.data}`, limits.guild))
    }
    const blocked = decisions.filter((d) => !d.allowed)
    if (blocked.length > 0) {
      c.header('Retry-After', String(Math.max(...blocked.map((d) => d.retryAfterSeconds))))
      return c.json({ error: 'rate_limited' }, 429)
    }
    await next()
  }
}
