import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { GateActor, GateScope, GateStatus, GateStore, GlobalEvent } from '../ports/gate-store'
import type { KeyProvider } from '../ports/key-provider'

const barRow = z.object({ bar_id: z.string() })
const statusRow = z.object({ guild_bar: z.boolean(), global_bar: z.boolean() })

/**
 * Postgres {@link GateStore}. A guild bar lives in the tenant table `guild_gates`; the global bar
 * is the single row of the non-tenant `global_gate`. Every call runs in `Db.withGuild` for the
 * acting (or checked) guild, and a bar or lift appends its chained event in the same transaction.
 * Primary keys make a repeated or same-tick bar a no-op.
 */
export class PgGateStore implements GateStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async bar(actor: GateActor, scope: GateScope): Promise<{ barId: string; created: boolean }> {
    return this.db.withGuild(actor.guildId, async (tx) => {
      const [inserted] =
        scope === 'global'
          ? await tx`
              insert into global_gate (barred_by) values (${actor.memberId})
              on conflict do nothing returning bar_id`
          : await tx`
              insert into guild_gates (guild_id, barred_by)
              values (${actor.guildId}, ${actor.memberId})
              on conflict do nothing returning bar_id`
      if (!inserted) {
        const [existing] =
          scope === 'global'
            ? await tx`select bar_id from global_gate`
            : await tx`select bar_id from guild_gates where guild_id = ${actor.guildId}`
        return { barId: barRow.parse(existing).bar_id, created: false }
      }
      const barId = barRow.parse(inserted).bar_id
      await appendEvent(tx, this.keys, 'gates.barred', {
        barId,
        scope,
        memberId: actor.memberId,
      })
      return { barId, created: true }
    })
  }

  async lift(actor: GateActor, scope: GateScope): Promise<string | null> {
    return this.db.withGuild(actor.guildId, async (tx) => {
      const [gone] =
        scope === 'global'
          ? await tx`delete from global_gate returning bar_id`
          : await tx`
              delete from guild_gates where guild_id = ${actor.guildId} returning bar_id`
      if (!gone) {
        return null
      }
      const barId = barRow.parse(gone).bar_id
      await appendEvent(tx, this.keys, 'gates.lifted', { barId, scope, memberId: actor.memberId })
      return barId
    })
  }

  async latestGlobalLift(guildId: string): Promise<string | null> {
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select payload ->> 'barId' as bar_id from events
        where guild_id = ${guildId} and type = 'gates.lifted' and payload ->> 'scope' = 'global'
        order by seq desc limit 1`
    )
    return row ? barRow.parse(row).bar_id : null
  }

  async announceGlobal(guildId: string, event: GlobalEvent): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      // One announcer per (guild, type, bar) at a time, so a re-run racing another never duplicates.
      await tx`select pg_advisory_xact_lock(
        hashtextextended(${`gates-announce:${guildId}:${event.type}:${event.barId}`}, 0))`
      const [seen] = await tx`
        select exists (
          select 1 from events
          where guild_id = ${guildId} and type = ${event.type} and payload ->> 'barId' = ${event.barId}
        ) as seen`
      if (z.object({ seen: z.boolean() }).parse(seen).seen) {
        return false
      }
      await appendEvent(tx, this.keys, event.type, {
        barId: event.barId,
        scope: 'global',
      })
      return true
    })
  }

  async isBarred(guildId: string): Promise<boolean> {
    const status = await this.status(guildId)
    return status.guild || status.global
  }

  async globalBarId(guildId: string): Promise<string | null> {
    const [row] = await this.db.withGuild(guildId, (tx) => tx`select bar_id from global_gate`)
    return row === undefined ? null : barRow.parse(row).bar_id
  }

  async status(guildId: string): Promise<GateStatus> {
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select exists (select 1 from guild_gates where guild_id = ${guildId}) as guild_bar,
               exists (select 1 from global_gate) as global_bar`
    )
    const parsed = statusRow.parse(row)
    return { guild: parsed.guild_bar, global: parsed.global_bar }
  }
}
