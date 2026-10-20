import { z } from 'zod'
import { safeEqual } from '../constant-time'
import type { KeyProvider } from '../ports/key-provider'

const PURPOSE = 'mcp-token'

/** Claims of an assignment token: the right of one Member to claim one Quest, until `exp` (epoch ms). */
const assignment = z.strictObject({
  k: z.literal('assign'),
  g: z.uuid(),
  q: z.uuid(),
  m: z.string().min(1).max(64),
  exp: z.number().int(),
})

/** Claims of a lease token: one delivery (`a`, the attempt, is the fencing token) of one Quest. */
const lease = z.strictObject({
  k: z.literal('lease'),
  g: z.uuid(),
  q: z.uuid(),
  a: z.number().int().min(1),
  m: z.string().min(1).max(64),
})

const claims = z.discriminatedUnion('k', [assignment, lease])
/** The signed claims of an MCP token. */
export type TokenClaims = z.infer<typeof claims>
/** Claims of an assignment token. */
export type AssignmentClaims = z.infer<typeof assignment>
/** Claims of a lease token. */
export type LeaseClaims = z.infer<typeof lease>

/**
 * Signs `value` into an opaque token. The guild id travels inside the signed claims, keyed under
 * that guild, so the server derives the guild from the token and a caller cannot name another.
 */
export async function mintToken(keys: KeyProvider, value: TokenClaims): Promise<string> {
  const payload = Buffer.from(JSON.stringify(claims.parse(value))).toString('base64url')
  const mac = await keys.mac(value.g, PURPOSE, new TextEncoder().encode(payload))
  return `${payload}.${mac}`
}

/** The claims of a token minted by {@link mintToken}, or null when malformed, forged or foreign. */
export async function verifyToken(keys: KeyProvider, token: string): Promise<TokenClaims | null> {
  const parts = token.split('.')
  const [payload, mac] = parts
  if (parts.length !== 2 || !payload || !mac) {
    return null
  }
  let json: unknown
  try {
    json = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
  } catch {
    return null
  }
  const parsed = claims.safeParse(json)
  if (!parsed.success) {
    return null
  }
  const expected = await keys.mac(parsed.data.g, PURPOSE, new TextEncoder().encode(payload))
  return safeEqual(expected, mac) ? parsed.data : null
}
