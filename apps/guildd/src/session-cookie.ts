import type { Context, MiddlewareHandler } from 'hono'
import { bearerToken } from './sensitive'

/** Name of the HttpOnly cookie that carries a browser session token (never readable by scripts). */
export const SESSION_COOKIE = 'guildhall_session'

/** Request header a browser sends on sign-in to receive a cookie instead of a body token. */
export const SESSION_MODE_HEADER = 'x-session-mode'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/** The session cookie's value in a `Cookie` header, or null. */
export function sessionCookieValue(header: string | null | undefined): string | null {
  for (const part of (header ?? '').split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name === SESSION_COOKIE) {
      const value = rest.join('=')
      return value === '' ? null : value
    }
  }
  return null
}

/** Whether the request reached guildd over https (directly, or via a trusted proxy's header). */
function isHttps(c: Context, trustProxy: boolean): boolean {
  const forwarded = trustProxy ? c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() : null
  return forwarded === 'https' || new URL(c.req.url).protocol === 'https:'
}

/**
 * `Secure` is kept everywhere except plain http on a loopback host (the Guild Master's own
 * machine), where browsers would otherwise drop the cookie.
 */
function isSecure(c: Context, trustProxy: boolean): boolean {
  return isHttps(c, trustProxy) || !LOOPBACK_HOSTS.has(new URL(c.req.url).hostname)
}

/** Builds the `Set-Cookie` value that carries `token` until `expiresAt`. */
export function sessionCookie(
  c: Context,
  trustProxy: boolean,
  token: string,
  maxAgeSeconds: number
): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
    'HttpOnly',
    'SameSite=Strict',
    ...(isSecure(c, trustProxy) ? ['Secure'] : []),
  ].join('; ')
}

/** The `Set-Cookie` value that removes the session cookie. */
export function clearedSessionCookie(c: Context, trustProxy: boolean): string {
  return sessionCookie(c, trustProxy, '', 0)
}

/**
 * Same-origin proof for a state-changing request: `Sec-Fetch-Site` when the browser sent it,
 * else the `Origin` host against the `Host` the request addressed. A request with neither
 * (not a browser) is refused: a cookie is only ever honoured for browsers.
 */
function sameOrigin(c: Context, trustProxy: boolean): boolean {
  const site = c.req.header('sec-fetch-site')
  if (site) {
    return site === 'same-origin' || site === 'none'
  }
  const origin = c.req.header('origin')
  if (!origin) {
    return false
  }
  const host = (trustProxy ? c.req.header('x-forwarded-host') : undefined) ?? c.req.header('host')
  try {
    return host !== undefined && new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Turns a session cookie into the bearer header every route already understands, so the rest of
 * guildd sees one kind of session. A bearer header wins and is never CSRF-checked (a script on
 * another site cannot attach it); a cookie-authenticated state-changing request must be
 * same-origin, or it is refused with 403 `csrf_refused`. WebSocket upgrades authenticate by
 * single-use ticket and are left untouched.
 */
export function sessionCookieAuth(trustProxy: boolean): MiddlewareHandler {
  return async (c, next) => {
    const token = sessionCookieValue(c.req.header('cookie'))
    if (
      !token ||
      bearerToken(c.req.header('authorization')) ||
      c.req.header('upgrade')?.toLowerCase() === 'websocket'
    ) {
      return next()
    }
    if (!SAFE_METHODS.has(c.req.method) && !sameOrigin(c, trustProxy)) {
      return c.json({ error: 'csrf_refused' }, 403)
    }
    const headers = new Headers(c.req.raw.headers)
    headers.set('authorization', `Bearer ${token}`)
    c.req.raw = new Request(c.req.raw, { headers })
    return next()
  }
}

/** True when the sign-in asked for a cookie session (a browser) rather than a body token. */
export function wantsCookie(c: Context): boolean {
  return c.req.header(SESSION_MODE_HEADER) === 'cookie'
}
