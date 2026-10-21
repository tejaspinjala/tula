import type { Db } from '../db/client'
import {
  type AwaitingSeal,
  type AwaitingSealPage,
  type AwaitingSealReader,
  MAX_AWAITING_SEAL_PAGE,
} from '../ports/awaiting-seal-reader'
import type { Clock } from '../ports/clock'
import { toQuest } from './pg-quest-queue'
import { SEAL_COLUMNS, sealRow, toSeal } from './pg-seal-store'

/**
 * Postgres {@link AwaitingSealReader}: one join of the guild's `awaiting_seal` Quests to the Seal
 * of their latest round (an indexed lookup per Quest), keeping only the Quests a pass has work
 * for, then one batch read of those Seals. Both queries and the page size are bounded, so the
 * cost follows the Quests with work, not the guild's history. A `requested` Seal past its expiry
 * reads as expired, as `PgSealStore` reads it.
 */
export class PgAwaitingSealReader implements AwaitingSealReader {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
  ) {}

  async due(guildId: string, page: { after?: string; limit: number }): Promise<AwaitingSealPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_AWAITING_SEAL_PAGE)
    const after = page.after === undefined ? 0 : Number(page.after)
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select q.*, latest.seal_id as latest_seal_id
        from quests q
        left join lateral (
          select seal_id, round, status, expires_at from seals s
          where s.guild_id = q.guild_id and s.quest_id = q.quest_id
          order by s.round desc limit 1
        ) latest on true
        where q.guild_id = ${guildId} and q.state = 'awaiting_seal' and q.seq > ${after}
          and (latest.seal_id is null or latest.round <> q.round
               or latest.status in ('consumed', 'denied', 'expired', 'council_approved')
               or (latest.status = 'requested' and latest.expires_at <= ${now}))
        order by q.seq limit ${limit + 1}`
      const held = rows.slice(0, limit)
      const sealIds = held.flatMap((r) =>
        typeof r.latest_seal_id === 'string' ? [r.latest_seal_id] : []
      )
      const sealRows =
        sealIds.length === 0
          ? []
          : await tx`
              select ${tx.unsafe(SEAL_COLUMNS)} from seals
              where guild_id = ${guildId} and seal_id in ${tx(sealIds)}`
      const seals = new Map(
        sealRows.map((r) => {
          const seal = toSeal(sealRow.parse(r), now)
          return [seal.id, seal] as const
        })
      )
      const items: AwaitingSeal[] = held.map((r) => ({
        quest: toQuest(r),
        seal: typeof r.latest_seal_id === 'string' ? (seals.get(r.latest_seal_id) ?? null) : null,
      }))
      const last = items.at(-1)
      return { items, next: rows.length > limit && last ? String(last.quest.seq) : null }
    })
  }

  async hasWork(guildId: string): Promise<boolean> {
    return (await this.due(guildId, { limit: 1 })).items.length > 0
  }
}
