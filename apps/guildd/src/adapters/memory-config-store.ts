import { classifyChange, defaultConfig, type GuildConfig, routingChanged } from '../guild-config'
import type { Clock } from '../ports/clock'
import {
  ConfigError,
  type ConfigStore,
  type ConfigVersion,
  type ConfigVersionSummary,
  type ProposeResult,
} from '../ports/config-store'
import type { ModelLedger } from '../ports/model-ledger'
import type { QuestQueue } from '../ports/quest-queue'

/** Memory adapter for {@link ConfigStore}: same rules, state in this instance only. */
export class MemoryConfigStore implements ConfigStore {
  private readonly guilds = new Map<string, ConfigVersion[]>()

  /**
   * `parking` are the stores a newly locked Hall is parked in, in the same call that puts the lock
   * in force (the Postgres adapter does it in one transaction); without them no Quests are parked or runs revoked here (the next dispatch pass still parks and kills
   * a locked Hall's live work).
   */
  constructor(
    private readonly clock: Clock,
    private readonly parking: {
      quests?: QuestQueue
      ledger?: Pick<ModelLedger, 'revokeHallRuns'>
    } = {}
  ) {}

  // Every method does its check and write with no await between them, so same-tick calls
  // cannot interleave.
  async seed(guildId: string): Promise<void> {
    if (this.guilds.has(guildId)) {
      return
    }
    this.guilds.set(guildId, [
      {
        version: 1,
        status: 'applied',
        kind: 'seed',
        change: 'neutral',
        baseVersion: null,
        createdAt: this.clock.now().toISOString(),
        config: defaultConfig(),
      },
    ])
  }

  async current(guildId: string): Promise<{ version: number; config: GuildConfig }> {
    return this.inForce(guildId)
  }

  async propose(
    guildId: string,
    config: GuildConfig,
    options?: { baseVersion?: number }
  ): Promise<ProposeResult> {
    if (config.sealPolicy === 'autonomous') {
      throw new ConfigError('seal_policy_locked', 0)
    }
    return await this.write(guildId, config, 'change', options?.baseVersion)
  }

  async confirm(guildId: string, version: number): Promise<void> {
    const versions = this.versions(guildId)
    const target = versions.find((v) => v.version === version)
    if (!target) {
      throw new ConfigError('not_found', version)
    }
    if (target.status !== 'pending') {
      throw new ConfigError('not_pending', version)
    }
    if (this.inForce(guildId).version !== target.baseVersion) {
      throw new ConfigError('stale', version)
    }
    const before = this.inForce(guildId).config
    target.status = 'applied'
    await this.parkNewlyLocked(guildId, before, target.config)
    if (routingChanged(before, target.config)) {
      await this.parking.quests?.wakeRoutingWaits(guildId)
    }
  }

  async restore(guildId: string, version: number): Promise<ProposeResult> {
    const target = this.versions(guildId).find((v) => v.version === version)
    if (!target) {
      throw new ConfigError('not_found', version)
    }
    return this.write(guildId, structuredClone(target.config), 'restore')
  }

  async get(guildId: string, version: number): Promise<ConfigVersion | null> {
    const found = this.guilds.get(guildId)?.find((v) => v.version === version)
    return found ? structuredClone(found) : null
  }

  async history(guildId: string, page: { after?: number; limit: number }) {
    const below = [...(this.guilds.get(guildId) ?? [])]
      .reverse()
      .filter((v) => page.after === undefined || v.version < page.after)
    const items = below.slice(0, page.limit)
    const last = items.at(-1)
    const versions: ConfigVersionSummary[] = items.map(({ config: _config, ...summary }) => ({
      ...summary,
    }))
    return { versions, next: below.length > page.limit && last ? last.version : null }
  }

  private versions(guildId: string): ConfigVersion[] {
    return this.guilds.get(guildId) ?? []
  }

  private inForce(guildId: string): { version: number; config: GuildConfig } {
    const applied = this.versions(guildId).filter((v) => v.status === 'applied')
    const top = applied.at(-1)
    if (!top) {
      throw new ConfigError('not_found', 0)
    }
    return { version: top.version, config: structuredClone(top.config) }
  }

  private async write(
    guildId: string,
    config: GuildConfig,
    kind: 'change' | 'restore',
    baseVersion?: number
  ): Promise<ProposeResult> {
    const base = this.inForce(guildId)
    if (baseVersion !== undefined && baseVersion !== base.version) {
      throw new ConfigError('stale', baseVersion)
    }
    const change = classifyChange(base.config, config)
    const versions = this.versions(guildId)
    const version = (versions.at(-1)?.version ?? 0) + 1
    const status = change === 'widening' ? 'pending' : 'applied'
    versions.push({
      version,
      status,
      kind,
      change,
      baseVersion: base.version,
      createdAt: this.clock.now().toISOString(),
      config: structuredClone(config),
    })
    if (status === 'applied') {
      await this.parkNewlyLocked(guildId, base.config, config)
      if (routingChanged(base.config, config)) {
        await this.parking.quests?.wakeRoutingWaits(guildId)
      }
    }
    return { version, status, change }
  }

  private async parkNewlyLocked(
    guildId: string,
    before: GuildConfig,
    after: GuildConfig
  ): Promise<void> {
    for (const hall of after.halls) {
      const was = before.halls.find((h) => h.id === hall.id)
      if (was && !was.locked && hall.locked) {
        await this.parking.ledger?.revokeHallRuns(guildId, hall.id)
        await this.parking.quests?.releaseLeases(guildId, 'routing_blocked', [hall.id])
      }
    }
  }
}
