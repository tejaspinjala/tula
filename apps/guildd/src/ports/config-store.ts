import type { TenantTx } from '../db/client'
import type { ChangeKind, GuildConfig } from '../guild-config'

/** Largest page a {@link ConfigStore.history} call returns. */
export const MAX_CONFIG_PAGE = 100

/** Why a config operation was refused. */
export type ConfigErrorCode = 'not_found' | 'not_pending' | 'stale' | 'seal_policy_locked'

/** Thrown by {@link ConfigStore.confirm} and {@link ConfigStore.restore}. */
export class ConfigError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    readonly version: number
  ) {
    super(`config version ${version}: ${code}`)
    this.name = 'ConfigError'
  }
}

/** One version of a guild's config. `pending` versions are stored but not in force. */
export interface ConfigVersion {
  version: number
  /** `applied` took effect when written (or was confirmed); `pending` awaits the Guild Master. */
  status: 'applied' | 'pending'
  kind: 'seed' | 'change' | 'restore'
  /** How the change moved risk relative to the config in force when it was proposed. */
  change: ChangeKind
  /** The version in force when this one was proposed; null for the seed. */
  baseVersion: number | null
  createdAt: string
  config: GuildConfig
}

/** A version without its document, for history lists. */
export type ConfigVersionSummary = Omit<ConfigVersion, 'config'>

/** What {@link ConfigStore.propose} and {@link ConfigStore.restore} report. */
export interface ProposeResult {
  version: number
  status: 'applied' | 'pending'
  change: ChangeKind
}

/**
 * Port for versioned guild config. Every change is a new version; widening changes (decided by
 * `classifyChange`, deterministic code) stay `pending` until {@link ConfigStore.confirm}, and
 * tightening or neutral ones apply at once. Callers gate `confirm` behind re-authentication.
 */
export interface ConfigStore {
  /** Writes version 1 (the default config) for a new guild; a no-op if it already has one. */
  seed(guildId: string, tx?: TenantTx): Promise<void>
  /** The config in force: the highest applied version. Throws `not_found` for an unseeded guild. */
  current(guildId: string): Promise<{ version: number; config: GuildConfig }>
  /**
   * Records `config` as a new version; applied at once unless it widens risk. With `baseVersion`,
   * refused as `stale` unless that is still the version in force (the caller edited a stale read).
   */
  propose(
    guildId: string,
    config: GuildConfig,
    options?: { baseVersion?: number }
  ): Promise<ProposeResult>
  /**
   * Applies a pending version. `not_pending` if it is already applied; `stale` if the config in
   * force is no longer the one it was proposed against; `not_found` if there is no such version.
   */
  confirm(guildId: string, version: number): Promise<void>
  /** Proposes an earlier version's config as a new version (same widening rules). */
  restore(guildId: string, version: number): Promise<ProposeResult>
  /** One version with its document, or null. */
  get(guildId: string, version: number): Promise<ConfigVersion | null>
  /** Versions newest first, strictly below `after`, at most `limit`; `next` is the cursor or null. */
  history(
    guildId: string,
    page: { after?: number; limit: number }
  ): Promise<{ versions: ConfigVersionSummary[]; next: number | null }>
}
