import type { MiddlewareHandler } from 'hono'
import type { IdentityProvider } from './ports/identity'

/** Request header carrying the re-authentication proof for a sensitive action. */
export const REAUTH_HEADER = 'x-reauth-proof'

/** Outcome of {@link checkSensitive}. */
export type SensitiveCheck =
  | { ok: true; guildId: string }
  | { ok: false; status: 401 | 403; error: 'unauthenticated' | 'reauth_required' }

/** Extracts the bearer token from an `Authorization` header value. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? '')
  return match?.[1] ?? null
}

/**
 * The reusable gate for any action marked sensitive (the Vault, key changes, ...): the caller
 * needs a live session AND an unexpired re-authentication proof issued to that session.
 * On success it names the session's guild; the caller must still act only on that guild.
 */
export async function checkSensitive(
  identity: IdentityProvider,
  headers: { get(name: string): string | null }
): Promise<SensitiveCheck> {
  const token = bearerToken(headers.get('authorization'))
  const session = token ? await identity.resolveSession(token) : null
  if (!token || !session) {
    return { ok: false, status: 401, error: 'unauthenticated' }
  }
  const proof = headers.get(REAUTH_HEADER)
  if (!proof || !(await identity.checkReauth(token, proof))) {
    return { ok: false, status: 403, error: 'reauth_required' }
  }
  return { ok: true, guildId: session.guildId }
}

/** Hono middleware form of {@link checkSensitive}: rejects with 401/403 before the handler runs. */
export function sensitiveAction(identity: IdentityProvider): MiddlewareHandler {
  return async (c, next) => {
    const check = await checkSensitive(identity, c.req.raw.headers)
    if (!check.ok) {
      return c.json({ error: check.error }, check.status)
    }
    await next()
  }
}
