import {
  assertGuildId,
  assertHash,
  hashBytes,
  type ObjectHead,
  type ObjectStore,
} from '../ports/object-store'

/** In-memory {@link ObjectStore} for tests and local runs; objects live only as long as the instance. */
export class MemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, Uint8Array>()

  /** Number of distinct stored objects across all guilds. */
  get size(): number {
    return this.objects.size
  }

  async put(guildId: string, bytes: Uint8Array): Promise<string> {
    assertGuildId(guildId)
    const hash = hashBytes(bytes)
    this.objects.set(`${guildId}/${hash}`, bytes.slice())
    return hash
  }

  async get(guildId: string, hash: string): Promise<Uint8Array | null> {
    assertGuildId(guildId)
    assertHash(hash)
    return this.objects.get(`${guildId}/${hash}`)?.slice() ?? null
  }

  async head(guildId: string, hash: string): Promise<ObjectHead | null> {
    assertGuildId(guildId)
    assertHash(hash)
    const found = this.objects.get(`${guildId}/${hash}`)
    return found ? { size: found.byteLength } : null
  }
}
