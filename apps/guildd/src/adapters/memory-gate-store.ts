import type { GateActor, GateScope, GateStatus, GateStore, GlobalEvent } from '../ports/gate-store'

/**
 * Memory {@link GateStore}: state in this instance only. Every method checks and writes
 * synchronously (no `await` between), so same-tick bars are as atomic as the Postgres adapter.
 */
export class MemoryGateStore implements GateStore {
  private readonly guilds = new Map<string, string>()
  private globalBar: string | null = null
  /** `guild|type|barId` of every global event already in a guild's log. */
  private readonly announced = new Set<string>()
  /** The latest global bar each guild's actor lifted. */
  private readonly lastLift = new Map<string, string>()

  constructor(
    /** Receives each change's event type and ids-only payload, as the Postgres adapter appends them. */
    private readonly onEvent: (guildId: string, type: string, payload: object) => void = () => {}
  ) {}

  /** Synchronous read for the memory Quest queue, which cannot await inside its atomic claim. */
  barredNow(guildId: string): boolean {
    return this.globalBar !== null || this.guilds.has(guildId)
  }

  async bar(actor: GateActor, scope: GateScope): Promise<{ barId: string; created: boolean }> {
    const existing = scope === 'global' ? this.globalBar : this.guilds.get(actor.guildId)
    if (existing) {
      return { barId: existing, created: false }
    }
    const barId = crypto.randomUUID()
    if (scope === 'global') {
      this.globalBar = barId
    } else {
      this.guilds.set(actor.guildId, barId)
    }
    if (scope === 'global') {
      this.announced.add(`${actor.guildId}|gates.barred|${barId}`)
    }
    this.onEvent(actor.guildId, 'gates.barred', { barId, scope, memberId: actor.memberId })
    return { barId, created: true }
  }

  async lift(actor: GateActor, scope: GateScope): Promise<string | null> {
    const barId = scope === 'global' ? this.globalBar : this.guilds.get(actor.guildId)
    if (!barId) {
      return null
    }
    if (scope === 'global') {
      this.globalBar = null
    } else {
      this.guilds.delete(actor.guildId)
    }
    if (scope === 'global') {
      this.announced.add(`${actor.guildId}|gates.lifted|${barId}`)
      this.lastLift.set(actor.guildId, barId)
    }
    this.onEvent(actor.guildId, 'gates.lifted', { barId, scope, memberId: actor.memberId })
    return barId
  }

  async latestGlobalLift(guildId: string): Promise<string | null> {
    return this.lastLift.get(guildId) ?? null
  }

  async announceGlobal(guildId: string, event: GlobalEvent): Promise<boolean> {
    const key = `${guildId}|${event.type}|${event.barId}`
    if (this.announced.has(key)) {
      return false
    }
    this.announced.add(key)
    this.onEvent(guildId, event.type, {
      barId: event.barId,
      scope: 'global',
    })
    return true
  }

  async isBarred(guildId: string): Promise<boolean> {
    return this.barredNow(guildId)
  }

  async status(guildId: string): Promise<GateStatus> {
    return { guild: this.guilds.has(guildId), global: this.globalBar !== null }
  }
}
