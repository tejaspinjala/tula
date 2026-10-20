import { z } from 'zod'

/** A secret's reference: the only handle callers ever hold (never the value). */
export const secretRef = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)

/** A secret value as accepted for storage: non-empty, bounded. */
export const secretValue = z.string().min(1).max(4096)

/** Largest page a {@link SecretStore.list} call returns. */
export const MAX_SECRET_PAGE = 100

/** Thrown by {@link SecretStore.add} when the guild already holds a secret under that ref. */
export class SecretExistsError extends Error {
  constructor(readonly ref: string) {
    super(`secret already exists: ${ref}`)
    this.name = 'SecretExistsError'
  }
}

/** Whether a secret reference currently resolves for a guild. */
export type SecretStatus = 'resolved' | 'missing'

/**
 * Port for the Vault. Values are envelope-encrypted at rest (per-guild data key wrapped through
 * the KeyProvider). No method here returns a value except {@link SecretStore.resolve}, which is
 * internal-only, for gateways, and has no route.
 */
export interface SecretStore {
  /** Stores `value` under `ref` for the guild; rejects with {@link SecretExistsError} if taken. */
  add(guildId: string, ref: string, value: string): Promise<void>
  /** Reports, for each ref asked about, whether it resolves for this guild. */
  check(guildId: string, refs: string[]): Promise<Array<{ ref: string; status: SecretStatus }>>
  /** Lists refs (never values) in ascending order, strictly after `after`, at most `limit`. */
  list(
    guildId: string,
    page: { after?: string; limit: number }
  ): Promise<{ refs: string[]; next: string | null }>
  /** Internal-only: decrypts the value for later gateways; null when missing. Never expose via a route. */
  resolve(guildId: string, ref: string): Promise<string | null>
}
