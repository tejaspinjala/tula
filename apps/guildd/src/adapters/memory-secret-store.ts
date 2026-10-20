import type { KeyProvider } from '../ports/key-provider'
import { SecretExistsError, type SecretStore } from '../ports/secret-store'
import { newDataKey, open, seal } from '../vault-crypto'

interface GuildVault {
  wrappedKey: Promise<Uint8Array>
  secrets: Map<string, Uint8Array>
  /** Refs taken or being sealed; claimed synchronously so concurrent adds cannot collide. */
  claimed: Set<string>
}

/** Memory adapter for {@link SecretStore}: same envelope encryption, state in this process only. */
export class MemorySecretStore implements SecretStore {
  private readonly vaults = new Map<string, GuildVault>()

  /** @param keys custody of the key that wraps each guild's data key. */
  constructor(private readonly keys: KeyProvider) {}

  async add(guildId: string, ref: string, value: string): Promise<void> {
    // No await between the existence check and the claim, so racing adds cannot both pass.
    let vault = this.vaults.get(guildId)
    if (!vault) {
      vault = {
        wrappedKey: this.keys.wrap(guildId, newDataKey()),
        secrets: new Map(),
        claimed: new Set(),
      }
      this.vaults.set(guildId, vault)
    }
    if (vault.claimed.has(ref)) {
      throw new SecretExistsError(ref)
    }
    vault.claimed.add(ref)
    try {
      const dataKey = await this.keys.unwrap(guildId, await vault.wrappedKey)
      vault.secrets.set(ref, await seal(dataKey, guildId, ref, value))
    } catch (error) {
      vault.claimed.delete(ref)
      throw error
    }
  }

  async check(guildId: string, refs: string[]) {
    const secrets = this.vaults.get(guildId)?.secrets
    return refs.map((ref) => ({
      ref,
      status: secrets?.has(ref) ? ('resolved' as const) : ('missing' as const),
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
    return open(await this.keys.unwrap(guildId, await vault.wrappedKey), guildId, ref, sealed)
  }

  /** Test window: the sealed bytes held for a secret. */
  async stored(guildId: string, ref: string): Promise<Uint8Array | null> {
    return this.vaults.get(guildId)?.secrets.get(ref) ?? null
  }
}
