import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { clientAddress, UNKNOWN_CLIENT } from './client-ip'
import type { RateLimiter, RateRule } from './ports/rate-limiter'

/** The unauthenticated identity routes that are rate limited. */
export type RateRoute =
  | 'signin-begin'
  | 'signin-finish'
  | 'passkeys-begin'
  | 'passkeys-finish'
  | 'founding'
  | 'reauth'
  | 'stream-ticket'
  | 'checkpoint-begin'
  | 'checkpoint-finish'
  | 'quest-post'
  | 'seal-posted'
  | 'mcp'

/** Limits for one route: per client address, and (for guild routes) per guild across all clients. */
export interface RouteLimits {
  client: RateRule
  /** Stricter rule for callers whose address is unknown (they all share one bucket); defaults to client. */
  unknown?: RateRule
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
  'signin-begin': ceremonyLimits(),
  'signin-finish': ceremonyLimits(),
  'passkeys-begin': ceremonyLimits(),
  'passkeys-finish': ceremonyLimits(),
  founding: {
    client: { limit: 10, windowMs: MINUTE },
    unknown: { limit: 3, windowMs: MINUTE },
  },
  // Issued to a signed-in session; a person opens few streams, so the guild ceiling is modest.
  'stream-ticket': {
    client: { limit: 30, windowMs: MINUTE },
    unknown: { limit: 10, windowMs: MINUTE },
    guild: { limit: 60, windowMs: MINUTE },
  },
  // Signed-in writes. They are cheap to call and expensive to serve (a chain read and a
  // signature ceremony, a database insert), so each is bounded per client and per guild.
  'checkpoint-begin': writeLimits(10, 30),
  'checkpoint-finish': writeLimits(10, 30),
  'quest-post': writeLimits(60, 300),
  'seal-posted': writeLimits(30, 120),
  // The MCP gateway: no guild in the path, so it is bounded per client; every tool call is also
  // authorised by a signed lease token, and a forged one costs a MAC check.
  mcp: {
    client: { limit: 600, windowMs: MINUTE },
    unknown: { limit: 120, windowMs: MINUTE },
  },
  // Session-bearing routes have no guild in the path, so there is no guild bucket.
  reauth: {
    client: { limit: 30, windowMs: MINUTE },
    unknown: { limit: 10, windowMs: MINUTE },
  },
}

/** 30 per client (10 for callers with no known address) and 120 per guild, per minute. */
function ceremonyLimits(): RouteLimits {
  return {
    client: { limit: 30, windowMs: MINUTE },
    unknown: { limit: 10, windowMs: MINUTE },
    guild: { limit: 120, windowMs: MINUTE },
  }
}

/** Per-minute limits for a signed-in write route: `client` per address, `guild` across all clients. */
function writeLimits(client: number, guild: number): RouteLimits {
  return {
    client: { limit: client, windowMs: MINUTE },
    unknown: { limit: Math.max(1, Math.floor(client / 3)), windowMs: MINUTE },
    guild: { limit: guild, windowMs: MINUTE },
  }
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
 * Middleware that counts the request against the client bucket and then, only if that allowed it,
 * the guild bucket (when the route has a valid `:id` guild); answers 429 with `Retry-After` once
 * either is exhausted. Callers with no known address share `limits.unknown` (stricter).
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
    const refuse = (retryAfterSeconds: number) => {
      c.header('Retry-After', String(retryAfterSeconds))
      return c.json({ error: 'rate_limited' }, 429)
    }
    const rule = client === UNKNOWN_CLIENT ? (limits.unknown ?? limits.client) : limits.client
    // The client bucket goes first: a blocked client must not spend the guild bucket, or one
    // address could exhaust it and lock the Guild Master out.
    const byClient = await limiter.hit(`${route}:ip:${client}`, rule)
    if (!byClient.allowed) {
      return refuse(byClient.retryAfterSeconds)
    }
    const guild = z.uuid().safeParse(c.req.param('id'))
    if (limits.guild && guild.success) {
      const byGuild = await limiter.hit(`${route}:guild:${guild.data}`, limits.guild)
      if (!byGuild.allowed) {
        return refuse(byGuild.retryAfterSeconds)
      }
    }
    await next()
  }
}
