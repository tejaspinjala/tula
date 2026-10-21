import type { JSONValue } from 'postgres'
import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import { classifyChange, defaultConfig, type GuildConfig, parseStoredConfig } from '../guild-config'
import {
  ConfigError,
  type ConfigStore,
  type ConfigVersion,
  type ConfigVersionSummary,
  type ProposeResult,
} from '../ports/config-store'
import type { KeyProvider } from '../ports/key-provider'

const versionRow = z.object({
  version: z.number().int(),
  status: z.enum(['applied', 'pending']),
  kind: z.enum(['seed', 'change', 'restore']),
  change: z.enum(['widening', 'tightening', 'neutral']),
  base_version: z.number().int().nullable(),
  created_at: z.coerce.date(),
  config: z.unknown(),
})

function toVersion(row: unknown): ConfigVersion {
  const r = versionRow.parse(row)
  return {
    version: r.version,
    status: r.status,
    kind: r.kind,
    change: r.change,
    baseVersion: r.base_version,
    createdAt: r.created_at.toISOString(),
    config: parseStoredConfig(r.config),
  }
}

/**
 * Postgres {@link ConfigStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild,
 * and every change appends a chained event in the same transaction. Writers serialise per guild
 * on a transaction-level advisory lock, so concurrent proposals get distinct versions.
 */
export class PgConfigStore implements ConfigStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async seed(guildId: string, tx?: TenantTx): Promise<void> {
    if (tx) {
      await this.seedIn(tx, guildId)
      return
    }
    await this.db.withGuild(guildId, (scoped) => this.seedIn(scoped, guildId))
  }

  async current(guildId: string) {
    return this.db.withGuild(guildId, async (tx) => {
      const top = await this.inForce(tx, guildId)
      return { version: top.version, config: top.config }
    })
  }

  async propose(
    guildId: string,
    config: GuildConfig,
    options?: { baseVersion?: number }
  ): Promise<ProposeResult> {
    if (config.sealPolicy === 'autonomous') {
      throw new ConfigError('seal_policy_locked', 0)
    }
    return this.db.withGuild(guildId, (tx) =>
      this.write(tx, guildId, config, 'change', options?.baseVersion)
    )
  }

  async confirm(guildId: string, version: number): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const [row] = await tx`
        select * from guild_config_versions where guild_id = ${guildId} and version = ${version}`
      if (!row) {
        throw new ConfigError('not_found', version)
      }
      const target = toVersion(row)
      if (target.status !== 'pending') {
        throw new ConfigError('not_pending', version)
      }
      if ((await this.inForce(tx, guildId)).version !== target.baseVersion) {
        throw new ConfigError('stale', version)
      }
      await tx`
        update guild_config_versions set status = 'applied'
        where guild_id = ${guildId} and version = ${version}`
      await appendEvent(tx, this.keys, 'config.version_confirmed', { version })
    })
  }

  async restore(guildId: string, version: number): Promise<ProposeResult> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select * from guild_config_versions where guild_id = ${guildId} and version = ${version}`
      if (!row) {
        throw new ConfigError('not_found', version)
      }
      return this.write(tx, guildId, toVersion(row).config, 'restore')
    })
  }

  async get(guildId: string, version: number): Promise<ConfigVersion | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select * from guild_config_versions where guild_id = ${guildId} and version = ${version}`
      return row ? toVersion(row) : null
    })
  }

  async history(guildId: string, page: { after?: number; limit: number }) {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select version, status, kind, change, base_version, created_at, config
        from guild_config_versions
        where guild_id = ${guildId} and version < ${page.after ?? 2_147_483_647}
        order by version desc limit ${page.limit + 1}`
    )
    const all = rows.map(toVersion)
    const items = all.slice(0, page.limit)
    const last = items.at(-1)
    const versions: ConfigVersionSummary[] = items.map(({ config: _config, ...summary }) => ({
      ...summary,
    }))
    return { versions, next: all.length > page.limit && last ? last.version : null }
  }

  private async lock(tx: TenantTx, guildId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`config:${guildId}`}, 0))`
  }

  private async seedIn(tx: TenantTx, guildId: string): Promise<void> {
    await this.lock(tx, guildId)
    const config = defaultConfig()
    const inserted = await tx`
      insert into guild_config_versions (guild_id, version, status, kind, change, config)
      values (${guildId}, 1, 'applied', 'seed', 'neutral', ${tx.json(toJson(config))})
      on conflict (guild_id, version) do nothing returning version`
    if (inserted.length > 0) {
      await appendEvent(tx, this.keys, 'config.seeded', { version: 1 })
    }
  }

  private async inForce(tx: TenantTx, guildId: string): Promise<ConfigVersion> {
    const [row] = await tx`
      select * from guild_config_versions
      where guild_id = ${guildId} and status = 'applied' order by version desc limit 1`
    if (!row) {
      throw new ConfigError('not_found', 0)
    }
    return toVersion(row)
  }

  private async write(
    tx: TenantTx,
    guildId: string,
    config: GuildConfig,
    kind: 'change' | 'restore',
    baseVersion?: number
  ): Promise<ProposeResult> {
    await this.lock(tx, guildId)
    const base = await this.inForce(tx, guildId)
    if (baseVersion !== undefined && baseVersion !== base.version) {
      throw new ConfigError('stale', baseVersion)
    }
    const change = classifyChange(base.config, config)
    const status = change === 'widening' ? 'pending' : 'applied'
    const [next] = await tx`
      select coalesce(max(version), 0) + 1 as version
      from guild_config_versions where guild_id = ${guildId}`
    const version = z.coerce.number().int().parse(next?.version)
    await tx`
      insert into guild_config_versions
        (guild_id, version, status, kind, change, base_version, config)
      values (${guildId}, ${version}, ${status}, ${kind}, ${change}, ${base.version},
        ${tx.json(toJson(config))})`
    await appendEvent(tx, this.keys, 'config.version_proposed', { version, status, kind, change })
    return { version, status, change }
  }
}

/** A parsed config is plain JSON; this narrows it to the driver's JSON type without a cast. */
function toJson(config: GuildConfig): JSONValue {
  return JSON.parse(JSON.stringify(config))
}
