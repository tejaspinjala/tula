import type { ActivityLog, NewActivity } from '../ports/activity-log'

/**
 * Memory adapter for {@link ActivityLog}: state in this instance only. It keeps the Postgres
 * guarantee that the check and the write have no await between them, so same-tick repeats
 * cannot both emit. `emittedEvents` lists what was emitted, for tests.
 */
export class MemoryActivityLog implements ActivityLog {
  private readonly last = new Map<string, number>()
  /** Every emitted activity, in order, with its guild. */
  readonly emittedEvents: Array<{ guildId: string } & NewActivity> = []

  async record(guildId: string, input: NewActivity): Promise<{ emitted: boolean }> {
    if (input.toHallId !== undefined) {
      // Cross-Hall activity is never coalesced, and never starts a window for in-Hall repeats.
      this.emittedEvents.push({ guildId, ...input })
      return { emitted: true }
    }
    const key = JSON.stringify([guildId, input.memberId, input.activity])
    const prior = this.last.get(key)
    if (prior !== undefined && prior > input.at.getTime() - input.windowMs) {
      return { emitted: false }
    }
    this.last.set(key, input.at.getTime())
    this.emittedEvents.push({ guildId, ...input })
    return { emitted: true }
  }
}
