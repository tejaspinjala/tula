import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { KeyProvider } from '../ports/key-provider'
import { SecretExistsError, type SecretStatus, type SecretStore } from '../ports/secret-store'
import { newDataKey, open, seal } from '../vault-crypto'

const keyRow = z.object({ wrapped_key: z.instanceof(Uint8Array) })
const secretRow = z.object({ sealed: z.instanceof(Uint8Array) })
const refRow = z.object({ ref: z.string() })

/**
 * Postgres {@link SecretStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * Rows hold only ciphertext; the per-guild data key is stored wrapped by the {@link KeyProvider}.
 */
export class PgSecretStore implements SecretStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async add(guildId: string, ref: string, value: string): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      const dataKey = await this.dataKey(tx, guildId, true)
      const sealed = Buffer.from(await seal(dataKey, guildId, ref, value))
      const inserted = await tx`
        insert into vault_secrets (guild_id, ref, sealed) values (${guildId}, ${ref}, ${sealed})
        on conflict (guild_id, ref) do nothing returning ref`
      if (inserted.length === 0) {
        throw new SecretExistsError(ref)
      }
      await appendEvent(tx, this.keys, 'vault.secret_added', { ref })
    })
  }

  async check(guildId: string, refs: string[]) {
    if (refs.length === 0) {
      return []
    }
    const found = await this.db.withGuild(
      guildId,
      (tx) => tx`select ref from vault_secrets where guild_id = ${guildId} and ref in ${tx(refs)}`
    )
    const present = new Set(found.map((r) => refRow.parse(r).ref))
    return refs.map((ref) => ({
      ref,
      status: (present.has(ref) ? 'resolved' : 'missing') satisfies SecretStatus,
    }))
  }

  async list(guildId: string, page: { after?: string; limit: number }) {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select ref from vault_secrets
        where guild_id = ${guildId} and ref > ${page.after ?? ''}
        order by ref limit ${page.limit + 1}`
    )
    const refs = rows.map((r) => refRow.parse(r).ref)
    const items = refs.slice(0, page.limit)
    const last = items.at(-1)
    return { refs: items, next: refs.length > page.limit && last ? last : null }
  }

  async resolve(guildId: string, ref: string): Promise<string | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select sealed from vault_secrets where guild_id = ${guildId} and ref = ${ref}`
      if (!row) {
        return null
      }
      const dataKey = await this.dataKey(tx, guildId, false)
      return open(dataKey, guildId, ref, secretRow.parse(row).sealed)
    })
  }

  /** The guild's unwrapped data key; with `create`, makes and stores one (wrapped) if absent. */
  private async dataKey(tx: TenantTx, guildId: string, create: boolean): Promise<Uint8Array> {
    let [row] = await tx`select wrapped_key from vault_keys where guild_id = ${guildId}`
    if (!row && create) {
      const wrapped = Buffer.from(await this.keys.wrap(guildId, newDataKey()))
      await tx`
        insert into vault_keys (guild_id, wrapped_key) values (${guildId}, ${wrapped})
        on conflict (guild_id) do nothing`
      ;[row] = await tx`select wrapped_key from vault_keys where guild_id = ${guildId}`
    }
    if (!row) {
      throw new Error('vault has no data key')
    }
    return this.keys.unwrap(guildId, keyRow.parse(row).wrapped_key)
  }
}
