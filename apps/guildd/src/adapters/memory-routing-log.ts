import {
  type LoggedRouting,
  MAX_ROUTING_PAGE,
  type RoutingEntry,
  type RoutingLog,
  type RoutingPage,
} from '../ports/routing-log'

/** Memory {@link RoutingLog}: same rules, state in this instance only. */
export class MemoryRoutingLog implements RoutingLog {
  private readonly guilds = new Map<string, LoggedRouting[]>()

  // No await between the duplicate check and the push, so same-tick calls cannot both insert.
  async record(guildId: string, entry: RoutingEntry): Promise<void> {
    const rows = this.guilds.get(guildId) ?? []
    if (rows.some((r) => r.decisionKey === entry.decisionKey)) {
      return
    }
    rows.push({ ...entry, seq: rows.length + 1 })
    this.guilds.set(guildId, rows)
  }

  async list(guildId: string, page: { after?: number; limit: number }): Promise<RoutingPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_ROUTING_PAGE)
    const after = page.after ?? Number.POSITIVE_INFINITY
    const matching = [...(this.guilds.get(guildId) ?? [])].reverse().filter((r) => r.seq < after)
    const entries = matching.slice(0, limit)
    const last = entries.at(-1)
    return { entries, next: matching.length > limit && last ? last.seq : null }
  }

  async forKeys(guildId: string, decisionKeys: readonly string[]): Promise<LoggedRouting[]> {
    const wanted = new Set(decisionKeys.slice(0, MAX_ROUTING_PAGE))
    return (this.guilds.get(guildId) ?? []).filter((r) => wanted.has(r.decisionKey))
  }
}
