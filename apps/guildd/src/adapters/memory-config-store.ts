import { classifyChange, defaultConfig, type GuildConfig } from '../guild-config'
import type { Clock } from '../ports/clock'
import {
  ConfigError,
  type ConfigStore,
  type ConfigVersion,
  type ConfigVersionSummary,
  type ProposeResult,
} from '../ports/config-store'

/** Memory adapter for {@link ConfigStore}: same rules, state in this instance only. */
export class MemoryConfigStore implements ConfigStore {
  private readonly guilds = new Map<string, ConfigVersion[]>()

  constructor(private readonly clock: Clock) {}

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

  async propose(guildId: string, config: GuildConfig): Promise<ProposeResult> {
    return this.write(guildId, config, 'change')
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
    target.status = 'applied'
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

  private write(guildId: string, config: GuildConfig, kind: 'change' | 'restore'): ProposeResult {
    const base = this.inForce(guildId)
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
    return { version, status, change }
  }
}
