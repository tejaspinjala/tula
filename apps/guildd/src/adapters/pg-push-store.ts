import { z } from 'zod'
import type { Db } from '../db/client'
import type {
  DeliveryClaim,
  DeliveryLease,
  PushStore,
  PushSubscription,
  PushSubscriptionPage,
} from '../ports/push-store'

const subscriptionRow = z.object({
  endpoint: z.string(),
  p256dh: z.string(),
  auth: z.string(),
  member_id: z.string(),
  since_seq: z.coerce.number(),
})
const cursorRow = z.object({ last_seq: z.coerce.number() })
const memberRow = z.object({ member_id: z.string() })
const stateRow = z.object({ state: z.enum(['pending', 'sent', 'failed']) })

/**
 * Postgres {@link PushStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * A delivery claim is an `insert ... on conflict do nothing` plus a conditional lease takeover,
 * so exactly one caller wins; the dispatch lock is a transaction-scoped advisory lock per guild.
 */
export class PgPushStore implements PushStore {
  constructor(private readonly db: Db) {}

  async add(
    guildId: string,
    memberId: string,
    s: PushSubscription,
    sinceSeq: number
  ): Promise<'added' | 'updated' | 'conflict'> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into push_subscriptions (guild_id, endpoint, member_id, p256dh, auth, since_seq)
        values (${guildId}, ${s.endpoint}, ${memberId}, ${s.p256dh}, ${s.auth}, ${sinceSeq})
        on conflict (guild_id, endpoint) do update
          set p256dh = excluded.p256dh, auth = excluded.auth
          where push_subscriptions.member_id = excluded.member_id
        returning (xmax = 0) as inserted`
    )
    const row = rows[0]
    if (!row) {
      return 'conflict'
    }
    return z.object({ inserted: z.boolean() }).parse(row).inserted ? 'added' : 'updated'
  }

  async remove(
    guildId: string,
    memberId: string,
    endpoint: string
  ): Promise<'removed' | 'not_found' | 'conflict'> {
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select member_id from push_subscriptions
        where guild_id = ${guildId} and endpoint = ${endpoint} for update`
      if (!found) {
        return 'not_found'
      }
      if (memberRow.parse(found).member_id !== memberId) {
        return 'conflict'
      }
      await tx`
        delete from push_subscriptions where guild_id = ${guildId} and endpoint = ${endpoint}`
      return 'removed'
    })
  }

  async drop(guildId: string, endpoint: string): Promise<boolean> {
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
        select endpoint, member_id, p256dh, auth, since_seq from push_subscriptions
        where guild_id = ${guildId}
          and (${after}::text is null or endpoint collate "C" > ${after}::text collate "C")
        order by endpoint collate "C" limit ${page.limit + 1}`
    )
    const all = rows.map((r) => {
      const { member_id: memberId, since_seq: sinceSeq, ...device } = subscriptionRow.parse(r)
      return { ...device, memberId, sinceSeq }
    })
    const subscriptions = all.slice(0, page.limit)
    const last = subscriptions.at(-1)
    return { subscriptions, next: all.length > page.limit && last ? last.endpoint : null }
  }

  async claimDelivery(
    guildId: string,
    sealId: string,
    endpoint: string,
    lease: DeliveryLease
  ): Promise<DeliveryClaim> {
    const until = new Date(lease.now.getTime() + lease.leaseMs)
    return this.db.withGuild(guildId, async (tx) => {
      const subscribed = await tx`
        select 1 as ok from push_subscriptions
        where guild_id = ${guildId} and endpoint = ${endpoint}`
      if (subscribed.length === 0) {
        return 'done'
      }
      const inserted = await tx`
        insert into push_deliveries (guild_id, seal_id, endpoint, state, attempts, lease_expires_at)
        values (${guildId}, ${sealId}::uuid, ${endpoint}, 'pending', 1, ${until})
        on conflict do nothing
        returning 1 as ok`
      if (inserted.length === 1) {
        return 'claimed'
      }
      const retaken = await tx`
        update push_deliveries set attempts = attempts + 1, lease_expires_at = ${until}
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}
          and state = 'pending' and lease_expires_at <= ${lease.now}
          and attempts < ${lease.maxAttempts}
        returning 1 as ok`
      if (retaken.length === 1) {
        return 'claimed'
      }
      const [row] = await tx`
        update push_deliveries set state = 'failed'
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}
          and state = 'pending' and lease_expires_at <= ${lease.now}
          and attempts >= ${lease.maxAttempts}
        returning state`
      if (row) {
        return 'done'
      }
      const [current] = await tx`
        select state from push_deliveries
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}`
      return current && stateRow.parse(current).state === 'pending' ? 'busy' : 'done'
    })
  }

  async completeDelivery(guildId: string, sealId: string, endpoint: string): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update push_deliveries set state = 'sent'
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}`
    )
  }

  async releaseDelivery(guildId: string, sealId: string, endpoint: string): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update push_deliveries set lease_expires_at = to_timestamp(0)
        where guild_id = ${guildId} and seal_id = ${sealId}::uuid and endpoint = ${endpoint}
          and state = 'pending'`
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

  withDispatchLock<T>(guildId: string, fn: () => Promise<T>): Promise<T> {
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`push-dispatch:${guildId}`}, 0))`
      return fn()
    })
  }
}
