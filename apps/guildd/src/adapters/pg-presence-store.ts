import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import type { PresenceState, PresenceStore } from '../ports/presence-store'

const presenceRow = z.object({
  away: z.boolean(),
  away_since: z.coerce.date().nullable(),
  away_until: z.coerce.date().nullable(),
})

function toState(row: unknown): PresenceState {
  const r = presenceRow.parse(row)
  return {
    away: r.away,
    since: r.away_since?.toISOString() ?? null,
    until: r.away_until?.toISOString() ?? null,
  }
}

/**
 * Postgres {@link PresenceStore}: one row per guild under forced RLS. Writers serialise per guild
 * on a transaction-level advisory lock, and each change appends its chained event in the same
 * transaction, so a state change and its audit event commit together.
 */
export class PgPresenceStore implements PresenceStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async get(guildId: string): Promise<PresenceState> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select away, away_since, away_until from guild_presence where guild_id = ${guildId}`
      return row ? toState(row) : { away: false, since: null, until: null }
    })
  }

  async goAway(guildId: string, until: string | null): Promise<PresenceState> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const [row] = await tx`
        select away, away_since, away_until from guild_presence where guild_id = ${guildId}`
      const current = row ? toState(row) : null
      const stillAway =
        current?.away === true &&
        current.since !== null &&
        (current.until === null || new Date(current.until).getTime() > now.getTime())
      const since = stillAway && current?.since ? current.since : now.toISOString()
      await tx`
        insert into guild_presence (guild_id, away, away_since, away_until, updated_at)
        values (${guildId}, true, ${since}, ${until}, ${now.toISOString()})
        on conflict (guild_id) do update
          set away = true, away_since = excluded.away_since, away_until = excluded.away_until,
              updated_at = excluded.updated_at`
      await appendEvent(tx, this.keys, 'guildmaster.away', { since, until })
      return { away: true, since, until }
    })
  }

  async returnHome(guildId: string): Promise<boolean> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const [row] = await tx`
        select away, away_since, away_until from guild_presence where guild_id = ${guildId}`
      const current = row ? toState(row) : null
      if (!current?.away) {
        return false
      }
      await tx`
        update guild_presence
        set away = false, away_since = null, away_until = null, updated_at = ${now.toISOString()}
        where guild_id = ${guildId}`
      await appendEvent(tx, this.keys, 'guildmaster.returned', { since: current.since })
      return true
    })
  }

  private async lock(tx: TenantTx, guildId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`presence:${guildId}`}, 0))`
  }
}
