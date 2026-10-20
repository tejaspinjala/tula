/** Metadata of a stored object. */
export interface ObjectHead {
  /** Size in bytes. */
  size: number
}

/**
 * Content-addressed blob storage, namespaced per guild: the same bytes stored by two guilds are
 * two objects, and a guild can only reach objects under its own namespace, even knowing a hash.
 * The hash is the lowercase hex SHA-256 of the bytes.
 */
export interface ObjectStore {
  /** Stores `bytes` for `guildId` (idempotent) and returns their SHA-256 hash. */
  put(guildId: string, bytes: Uint8Array): Promise<string>
  /** Returns the bytes stored under `hash` for `guildId`, or null when there are none. */
  get(guildId: string, hash: string): Promise<Uint8Array | null>
  /** Returns the metadata of the object under `hash` for `guildId`, or null when there is none. */
  head(guildId: string, hash: string): Promise<ObjectHead | null>
}

/** SHA-256 of `bytes` as lowercase hex: the content address. */
export function hashBytes(bytes: Uint8Array): string {
  return new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
}

const GUILD_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/

/** Throws unless `guildId` is a UUID: adapters build keys from it, so it must not carry a path. */
export function assertGuildId(guildId: string): void {
  if (!GUILD_ID.test(guildId)) {
    throw new Error('invalid guild id')
  }
}

/** Throws unless `hash` is 64 lowercase hex characters. */
export function assertHash(hash: string): void {
  if (!HASH.test(hash)) {
    throw new Error('invalid object hash')
  }
}
