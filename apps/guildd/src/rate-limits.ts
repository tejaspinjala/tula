import type { Context, MiddlewareHandler } from 'hono'
import { z } from 'zod'
import { clientAddress, UNKNOWN_CLIENT } from './client-ip'
import type { RateLimiter, RateRule } from './ports/rate-limiter'

/** The routes that are rate limited: identity ceremonies, session writes and reads, and token-bearing calls. */
export type RateRoute =
  | 'signin-begin'
  | 'signin-finish'
  | 'passkeys-begin'
  | 'passkeys-finish'
  | 'enrol-begin'
  | 'enrol-finish'
  | 'desktop-begin'
  | 'desktop-exchange'
  | 'founding'
  | 'founding-begin'
  | 'founding-status'
  | 'reauth'
  | 'stream-ticket'
  | 'checkpoint-begin'
  | 'checkpoint-finish'
  | 'quest-post'
  | 'summon'
  | 'summon-status'
  | 'dispatch'
  | 'cost-per-post'
  | 'seal-posted'
  | 'gateway-call'
  | 'mcp'
  | 'proposal-post'
  | 'push-subscribe'
  | 'learning-scan'
  | 'events-history'
  | 'missives-read'
  | 'mailbox-mark'
  | 'dossier-read'
  | 'dossier-write'
  | 'bug-report-read'
  | 'bug-report-write'
  | 'presence-read'
  | 'presence-write'
  | 'session-check'
  | 'rite-read'
  | 'rite-write'
  | 'rite-run'
  | 'archive-export'

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
  'enrol-begin': ceremonyLimits(),
  'enrol-finish': ceremonyLimits(),
  'desktop-begin': ceremonyLimits(),
  'desktop-exchange': ceremonyLimits(),
  founding: {
    client: { limit: 10, windowMs: MINUTE },
    unknown: { limit: 3, windowMs: MINUTE },
  },
  // A cheap boolean read the signed-out page makes once per load.
  // Starting the founding ceremony writes nothing, so it is cheap; finishing is the costly step.
  'founding-begin': ceremonyLimits(),
  'founding-status': {
    client: { limit: 30, windowMs: MINUTE },
    unknown: { limit: 10, windowMs: MINUTE },
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
  // Starting a worker spends money and a container: far tighter than other writes.
  summon: writeLimits(10, 30),
  // The Summon panel polls its status; a read is cheap but still bounded per client and guild.
  'summon-status': writeLimits(60, 240),
  // A dispatch pass claims a Quest and starts a worker (a container, a run): as tight as Summon.
  dispatch: writeLimits(10, 30),
  // A read that scans the ledger's per-Quest rows and their Seals: bounded per client and guild.
  'cost-per-post': writeLimits(30, 120),
  'seal-posted': writeLimits(30, 120),
  // Run-token calls to the model gateway: each spends money. Every sandbox reaches guildd
  // through the one proxy address, so the client bucket is loose; the guild the verified run
  // token names is bounded tighter (charged after the token verifies). Daily caps bound spend.
  'gateway-call': {
    client: { limit: 1200, windowMs: MINUTE },
    unknown: { limit: 60, windowMs: MINUTE },
    guild: { limit: 300, windowMs: MINUTE },
  },
  // The MCP gateway: no guild in the path, so the guild bucket is charged to the guild named by
  // the verified lease or assignment token; a forged token costs a MAC check and spends nothing.
  mcp: {
    client: { limit: 2400, windowMs: MINUTE },
    unknown: { limit: 120, windowMs: MINUTE },
    guild: { limit: 600, windowMs: MINUTE },
  },
  'proposal-post': writeLimits(60, 300),
  // A person registers a handful of devices; each call is a dispatch scan and a database write.
  'push-subscribe': writeLimits(20, 60),
  // A scan makes outbound GitHub calls and writes rows, so it is bounded per client and guild.
  'learning-scan': writeLimits(3, 6),
  // History reads page through the whole chain and fold it, so they are bounded per client and guild.
  'events-history': writeLimits(60, 240),
  'missives-read': writeLimits(60, 240),
  // Marking a Mailbox read is one small upsert, made once each time a Mailbox opens.
  'mailbox-mark': writeLimits(60, 240),
  // Reading a Dossier is a cheap indexed read; creating one re-reads every cited artifact from the object store.
  'dossier-read': writeLimits(60, 240),
  'dossier-write': writeLimits(20, 60),
  // Filing a Bug Report posts a Quest and appends to the audit chain; reading one is an indexed read.
  'bug-report-read': writeLimits(60, 240),
  'bug-report-write': writeLimits(20, 60),
  // Presence is one small row: reading it is cheap; away and return each write it and the audit chain.
  'presence-read': writeLimits(60, 240),
  'presence-write': writeLimits(20, 60),
  // Session checks and sign-outs are cheap reads, but unauthenticated callers can hammer them.
  'session-check': { client: { limit: 120, windowMs: MINUTE } },
  // Rite reads page stored graphs; saves validate a graph; a run posts Quests: tightest.
  'rite-read': writeLimits(60, 240),
  'rite-write': writeLimits(20, 60),
  'rite-run': writeLimits(10, 30),
  // An export reads every note and zips them: a few a minute is plenty.
  'archive-export': writeLimits(3, 10),
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
 * either is exhausted. On `session` routes ({@link RATE_ROUTE_AUTH}) the guild bucket is charged
 * only when `sessionGuild` returns the path's guild. Callers with no known address share `limits.unknown` (stricter).
 * The client address comes from {@link clientAddress}: the socket peer, or the last
 * `X-Forwarded-For` hop only when `trustProxy` (env `TRUST_PROXY`) is set.
 */
export function rateLimit(
  limiter: RateLimiter,
  route: RateRoute,
  limits: RouteLimits,
  trustProxy: boolean,
  sessionGuild: (c: Context) => Promise<string | null> = async () => null
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
    // Session routes charge the guild bucket only once the session resolves to this very guild;
    // a route with no guild rule never looks the session up.
    if (
      limits.guild &&
      guild.success &&
      (RATE_ROUTE_AUTH[route] === 'unauthenticated' || (await sessionGuild(c)) === guild.data)
    ) {
      const byGuild = await limiter.hit(`${route}:guild:${guild.data}`, limits.guild)
      if (!byGuild.allowed) {
        return refuse(byGuild.retryAfterSeconds)
      }
    }
    await next()
  }
}

/** Whether a limited route is reached with a session or without one; see {@link RATE_ROUTE_AUTH}. */
export type RateAuth = 'session' | 'unauthenticated'

/**
 * How each limited route is reached. `unauthenticated` means not session-gated: the guild bucket,
 * if any, is charged before auth (a caller has no session yet). `session` routes charge it only
 * after the caller's session resolves to the guild in the path, so another guild's session, or
 * none, cannot spend it. `gateway-call` and `mcp` carry tokens, not sessions: their guild bucket is
 * charged by the handler after the token verifies, never by this middleware.
 */
export const RATE_ROUTE_AUTH: Record<RateRoute, RateAuth> = {
  'signin-begin': 'unauthenticated',
  'signin-finish': 'unauthenticated',
  'passkeys-begin': 'unauthenticated',
  'passkeys-finish': 'unauthenticated',
  'enrol-begin': 'unauthenticated',
  'enrol-finish': 'unauthenticated',
  'desktop-begin': 'unauthenticated',
  'desktop-exchange': 'unauthenticated',
  founding: 'unauthenticated',
  'founding-begin': 'unauthenticated',
  'founding-status': 'unauthenticated',
  reauth: 'unauthenticated',
  'stream-ticket': 'session',
  'checkpoint-begin': 'session',
  'checkpoint-finish': 'session',
  'quest-post': 'session',
  summon: 'session',
  'summon-status': 'session',
  dispatch: 'session',
  'cost-per-post': 'session',
  'seal-posted': 'session',
  'gateway-call': 'unauthenticated',
  mcp: 'unauthenticated',
  'proposal-post': 'session',
  'push-subscribe': 'session',
  'learning-scan': 'session',
  'events-history': 'session',
  'missives-read': 'session',
  'mailbox-mark': 'session',
  'dossier-read': 'session',
  'dossier-write': 'session',
  'bug-report-read': 'session',
  'bug-report-write': 'session',
  'presence-read': 'session',
  'presence-write': 'session',
  'session-check': 'unauthenticated',
  'rite-read': 'session',
  'rite-write': 'session',
  'rite-run': 'session',
  'archive-export': 'session',
}
