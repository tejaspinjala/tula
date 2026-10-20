import { z } from 'zod'
import type { Db } from '../db/client'
import type { PushStore, PushSubscription, PushSubscriptionPage } from '../ports/push-store'

const subscriptionRow = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  member_id: z.string(),
})
const cursorRow = z.object({ last_seq: z.coerce.number() })

/**
 * Postgres {@link PushStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * A delivery claim is one `insert ... on conflict do nothing`, so exactly one caller wins.
 */
export class PgPushStore implements PushStore {
  constructor(private readonly db: Db) {}

  async add(guildId: string, memberId: string, s: PushSubscription): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into push_subscriptions (guild_id, endpoint, member_id, p256dh, auth)
        values (${guildId}, ${s.endpoint}, ${memberId}, ${s.p256dh}, ${s.auth})
        on conflict (guild_id, endpoint) do update
          set member_id = excluded.member_id, p256dh = excluded.p256dh, auth = excluded.auth`
    )
  }

  async remove(guildId: string, endpoint: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        delete from push_subscriptions where guild_id = ${guildId} and endpoint = ${endpoint}
        returning 1 as ok`
    )
    return rows.length === 1
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number }
  ): Promise<PushSubscriptionPage> {
    const after = page.after ?? null
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select endpoint, member_id, p256dh, auth from push_subscriptions
        where guild_id = ${guildId}
          and (${after}::text is null or endpoint collate "C" > ${after}::text collate "C")
        order by endpoint collate "C" limit ${page.limit + 1}`
    )
    const all = rows.map((r) => {
      const { member_id: memberId, ...device } = subscriptionRow.parse(r)
      return { ...device, memberId }
    })
    const subscriptions = all.slice(0, page.limit)
    const last = subscriptions.at(-1)
    return { subscriptions, next: all.length > page.limit && last ? last.endpoint : null }
  }

  async claimDelivery(guildId: string, sealId: string, endpoint: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into push_deliveries (guild_id, seal_id, endpoint)
        select guild_id, ${sealId}::uuid, endpoint from push_subscriptions
        where guild_id = ${guildId} and endpoint = ${endpoint}
        on conflict do nothing
        returning 1 as ok`
    )
    return rows.length === 1
  }

  async releaseDelivery(guildId: string, sealId: string, endpoint: string): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        delete from push_deliveries
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}`
    )
  }

  async cursor(guildId: string): Promise<number> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`select last_seq from push_cursors where guild_id = ${guildId}`
    )
    const row = rows[0]
    return row ? cursorRow.parse(row).last_seq : 0
  }

  async advanceCursor(guildId: string, seq: number): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into push_cursors (guild_id, last_seq) values (${guildId}, ${seq})
        on conflict (guild_id) do update
          set last_seq = greatest(push_cursors.last_seq, excluded.last_seq)`
    )
  }
}
