import { createHash } from 'node:crypto'
import { canonicalJson } from '../audit-chain'
import type { Charter } from './charter'

/**
 * A sha256 of what the caller asked for: the Charter and the base version. It is taken from the
 * request, not from the computed config and drafts, because those depend on the guild's state
 * (a Rite name gets a suffix once it exists), so an honest retry would otherwise look different.
 * The same `importId` with a different hash is a reused id, not a retry.
 */
export function charterRequestHash(charter: Charter, baseVersion: number): string {
  return createHash('sha256').update(canonicalJson({ charter, baseVersion })).digest('hex')
}
