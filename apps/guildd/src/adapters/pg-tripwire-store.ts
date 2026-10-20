import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import {
  type HallPause,
  MAX_TRIPWIRE_PAGE,
  type NewPause,
  newPause,
  type PausePage,
  type TripwireStore,
} from '../ports/tripwire-store'

const row = z.object({
  pause_id: z.string(),
  seq: z.coerce.number(),
  hall_id: z.string(),
  tripwire: newPause.shape.tripwire,
  observed: z.number(),
  threshold: z.number(),
  paused_at: z.coerce.date(),
})

function toPause(raw: unknown): HallPause {
  const r = row.parse(raw)
  return {
    id: r.pause_id,
    seq: r.seq,
    hallId: r.hall_id,
    tripwire: r.tripwire,
    observed: r.observed,
    threshold: r.threshold,
    pausedAt: r.paused_at.toISOString(),
  }
}

/**
 * Postgres {@link TripwireStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild),
 * and a pause or resume appends its chained event in the same transaction. The unique
 * (guild, Hall) key makes a repeated or same-tick pause a no-op.
 */
export class PgTripwireStore implements TripwireStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async pause(guildId: string, input: NewPause): Promise<{ pause: HallPause; created: boolean }> {
    return this.db.withGuild(guildId, async (tx) => {
      const at = this.clock.now()
      const [inserted] = await tx`
        insert into hall_pauses (guild_id, hall_id, tripwire, observed, threshold, paused_at)
        values (${guildId}, ${input.hallId}, ${input.tripwire}, ${input.observed},
                ${input.threshold}, ${at})
        on conflict (guild_id, hall_id) do nothing
        returning pause_id, seq, hall_id, tripwire, observed, threshold, paused_at`
      if (!inserted) {
        const [existing] = await tx`
          select pause_id, seq, hall_id, tripwire, observed, threshold, paused_at
          from hall_pauses where guild_id = ${guildId} and hall_id = ${input.hallId}`
        return { pause: toPause(existing), created: false }
      }
      const pause = toPause(inserted)
      await appendEvent(tx, this.keys, 'hall.paused', {
        pauseId: pause.id,
        hallId: pause.hallId,
        tripwire: pause.tripwire,
      })
      return { pause, created: true }
    })
  }

  async resume(guildId: string, hallId: string): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      const [gone] = await tx`
        delete from hall_pauses where guild_id = ${guildId} and hall_id = ${hallId}
        returning pause_id`
      if (!gone) {
        return false
      }
      await appendEvent(tx, this.keys, 'hall.resumed', {
        pauseId: z.object({ pause_id: z.string() }).parse(gone).pause_id,
        hallId,
      })
      return true
    })
  }

  async isPaused(guildId: string, hallId: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select 1 as one from hall_pauses where guild_id = ${guildId} and hall_id = ${hallId}`
    )
    return rows.length > 0
  }

  async list(guildId: string, page: { after?: number; limit: number }): Promise<PausePage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_TRIPWIRE_PAGE)
    const after = page.after ?? 0
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select pause_id, seq, hall_id, tripwire, observed, threshold, paused_at
        from hall_pauses where guild_id = ${guildId} and seq > ${after}
        order by seq limit ${limit + 1}`
    )
    const pauses = rows.slice(0, limit).map(toPause)
    const last = pauses.at(-1)
    return { pauses, next: rows.length > limit && last ? last.seq : null }
  }
}
