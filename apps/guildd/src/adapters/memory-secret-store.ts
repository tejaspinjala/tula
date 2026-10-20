import type { KeyProvider } from '../ports/key-provider'
import { SecretExistsError, type SecretStatus, type SecretStore } from '../ports/secret-store'
import { newDataKey, open, seal } from '../vault-crypto'

interface GuildVault {
  wrappedKey: Uint8Array
  secrets: Map<string, Uint8Array>
}

/** Memory adapter for {@link SecretStore}: same envelope encryption, state in this process only. */
export class MemorySecretStore implements SecretStore {
  private readonly vaults = new Map<string, GuildVault>()

  /** @param keys custody of the key that wraps each guild's data key. */
  constructor(private readonly keys: KeyProvider) {}

  async add(guildId: string, ref: string, value: string): Promise<void> {
    let vault = this.vaults.get(guildId)
    if (vault?.secrets.has(ref)) {
      throw new SecretExistsError(ref)
    }
    if (!vault) {
      vault = { wrappedKey: await this.keys.wrap(guildId, newDataKey()), secrets: new Map() }
      this.vaults.set(guildId, vault)
    }
    const dataKey = await this.keys.unwrap(guildId, vault.wrappedKey)
    vault.secrets.set(ref, await seal(dataKey, guildId, ref, value))
  }

  async check(guildId: string, refs: string[]) {
    const secrets = this.vaults.get(guildId)?.secrets
    return refs.map((ref) => ({
      ref,
      status: (secrets?.has(ref) ? 'resolved' : 'missing') satisfies SecretStatus,
    }))
  }

  async list(guildId: string, page: { after?: string; limit: number }) {
    const all = [...(this.vaults.get(guildId)?.secrets.keys() ?? [])].sort()
    const after = page.after
    const eligible = after === undefined ? all : all.filter((ref) => ref > after)
    const refs = eligible.slice(0, page.limit)
    const last = refs.at(-1)
    return { refs, next: eligible.length > refs.length && last ? last : null }
  }

  async resolve(guildId: string, ref: string): Promise<string | null> {
    const vault = this.vaults.get(guildId)
    const sealed = vault?.secrets.get(ref)
    if (!vault || !sealed) {
      return null
    }
    return open(await this.keys.unwrap(guildId, vault.wrappedKey), guildId, ref, sealed)
  }

  /** Test window: the sealed bytes held for a secret. */
  async stored(guildId: string, ref: string): Promise<Uint8Array | null> {
    return this.vaults.get(guildId)?.secrets.get(ref) ?? null
  }
}
