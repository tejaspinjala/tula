import type { IdentityProvider, Principal } from './ports/identity'

/** Request header carrying the re-authentication proof for a sensitive action. */
export const REAUTH_HEADER = 'x-reauth-proof'

/** Outcome of {@link checkSensitive}. */
export type SensitiveCheck<P extends { guildId: string } = Principal> =
  | { ok: true; guildId: string; principal: P }
  | { ok: false; status: 401 | 403; error: 'unauthenticated' | 'reauth_required' }

/** Extracts the bearer token from an `Authorization` header value. */
export function bearerToken(header: string | null | undefined): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? '')
  return match?.[1] ?? null
}

/**
 * The reusable gate for any action marked sensitive (the Vault, key changes, ...): the caller
 * needs a live session AND an unexpired re-authentication proof issued to that session. The proof
 * is spent by a successful check, so each sensitive action needs its own fresh re-authentication.
 * On success it names the session's guild; the caller must still act only on that guild.
 */
export async function checkSensitive<P extends { guildId: string } = Principal>(
  identity: {
    resolveSession(sessionToken: string): Promise<P | null>
    consumeReauth(sessionToken: string, proof: string): Promise<boolean>
  },
  headers: { get(name: string): string | null }
): Promise<SensitiveCheck<P>> {
  const token = bearerToken(headers.get('authorization'))
  const session = token ? await identity.resolveSession(token) : null
  if (!token || !session) {
    return { ok: false, status: 401, error: 'unauthenticated' }
  }
  const proof = headers.get(REAUTH_HEADER)
  if (!proof || !(await identity.consumeReauth(token, proof))) {
    return { ok: false, status: 403, error: 'reauth_required' }
  }
  return { ok: true, guildId: session.guildId, principal: session }
}
