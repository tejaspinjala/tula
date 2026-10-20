import type { Clock } from '../ports/clock'
import {
  type HallPause,
  MAX_TRIPWIRE_PAGE,
  type NewPause,
  type PausePage,
  type TripwireStore,
} from '../ports/tripwire-store'

/**
 * Memory {@link TripwireStore}: state in this instance only. Every method checks and writes
 * synchronously (no `await` between), so same-tick pauses are as atomic as the Postgres adapter.
 */
export class MemoryTripwireStore implements TripwireStore {
  private readonly guilds = new Map<string, Map<string, HallPause>>()
  private readonly seqs = new Map<string, number>()

  constructor(
    private readonly clock: Clock,
    /** Receives each change's event type and ids-only payload, as the Postgres adapter appends them. */
    private readonly onEvent: (guildId: string, type: string, payload: object) => void = () => {}
  ) {}

  private halls(guildId: string): Map<string, HallPause> {
    let halls = this.guilds.get(guildId)
    if (!halls) {
      halls = new Map()
      this.guilds.set(guildId, halls)
    }
    return halls
  }

  /** Synchronous read for the memory Quest queue, which cannot await inside its atomic claim. */
  pausedNow(guildId: string, hallId: string): boolean {
    return this.halls(guildId).has(hallId)
  }

  async pause(guildId: string, input: NewPause): Promise<{ pause: HallPause; created: boolean }> {
    const halls = this.halls(guildId)
    const existing = halls.get(input.hallId)
    if (existing) {
      return { pause: existing, created: false }
    }
    const seq = (this.seqs.get(guildId) ?? 0) + 1
    this.seqs.set(guildId, seq)
    const pause: HallPause = {
      ...input,
      id: crypto.randomUUID(),
      seq,
      pausedAt: this.clock.now().toISOString(),
    }
    halls.set(input.hallId, pause)
    this.onEvent(guildId, 'hall.paused', {
      pauseId: pause.id,
      hallId: pause.hallId,
      tripwire: pause.tripwire,
    })
    return { pause, created: true }
  }

  async resume(guildId: string, hallId: string): Promise<boolean> {
    const halls = this.halls(guildId)
    const existing = halls.get(hallId)
    if (!existing) {
      return false
    }
    halls.delete(hallId)
    this.onEvent(guildId, 'hall.resumed', { pauseId: existing.id, hallId })
    return true
  }

  async isPaused(guildId: string, hallId: string): Promise<boolean> {
    return this.pausedNow(guildId, hallId)
  }

  async list(guildId: string, page: { after?: number; limit: number }): Promise<PausePage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_TRIPWIRE_PAGE)
    const after = page.after ?? 0
    const rows = [...this.halls(guildId).values()]
      .filter((p) => p.seq > after)
      .sort((a, b) => a.seq - b.seq)
    const pauses = rows.slice(0, limit)
    const last = pauses.at(-1)
    return { pauses, next: rows.length > limit && last ? last.seq : null }
  }
}
