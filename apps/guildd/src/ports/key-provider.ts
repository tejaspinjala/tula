/**
 * Port for key custody. The master secret never leaves the adapter: callers get keyed MACs and
 * wrap/unwrap, never key bytes, and nothing here is stored in Postgres. Per-guild keys are derived
 * from the master secret, so one guild's key cannot stand in for another's.
 * The Vault wraps per-guild data keys with {@link KeyProvider.wrap} and {@link KeyProvider.unwrap}.
 */
export interface KeyProvider {
  /**
   * HMAC-SHA256 (lowercase hex) of `data` under the key derived for `guildId` and `purpose`.
   * Deterministic: the same inputs give the same MAC, across instances over the same custody.
   */
  mac(guildId: string, purpose: string, data: Uint8Array): Promise<string>
  /**
   * Resolves the key for `guildId` and `purpose` once and returns a signer over it, so bulk work
   * (verifying a whole chain) pays for key derivation once. Agrees with {@link KeyProvider.mac}.
   */
  macFor(guildId: string, purpose: string): Promise<(data: Uint8Array) => Promise<string>>
  /** Encrypts `plaintext` for `guildId` (authenticated, bound to the guild); the result is opaque. */
  wrap(guildId: string, plaintext: Uint8Array): Promise<Uint8Array>
  /** Reverses {@link KeyProvider.wrap}; rejects on tampering or when `guildId` differs. */
  unwrap(guildId: string, wrapped: Uint8Array): Promise<Uint8Array>
}
