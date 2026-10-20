import type {
  DeliveryClaim,
  DeliveryLease,
  PushStore,
  PushSubscription,
  PushSubscriptionPage,
  StoredPushSubscription,
} from '../ports/push-store'

interface Delivery {
  state: 'pending' | 'sent' | 'failed'
  attempts: number
  leaseUntil: number
}

interface GuildPush {
  subscriptions: Map<string, StoredPushSubscription>
  deliveries: Map<string, Delivery>
  cursor: number
  dispatch: { holder: string; until: number } | undefined
}

/**
 * Memory {@link PushStore}. Every operation checks and writes with no `await` between, so claims
 * and the dispatch lease are atomic. State is per instance.
 */
export class MemoryPushStore implements PushStore {
  private readonly guilds = new Map<string, GuildPush>()

  private of(guildId: string): GuildPush {
    let state = this.guilds.get(guildId)
    if (!state) {
      state = {
        subscriptions: new Map(),
        deliveries: new Map(),
        cursor: 0,
        dispatch: undefined,
      }
      this.guilds.set(guildId, state)
    }
    return state
  }

  private forget(state: GuildPush, endpoint: string): void {
    for (const key of state.deliveries.keys()) {
      if (key.endsWith(`|${endpoint}`)) {
        state.deliveries.delete(key)
      }
    }
    state.subscriptions.delete(endpoint)
  }

  async add(
    guildId: string,
    memberId: string,
    subscription: PushSubscription,
    sinceSeq: number
  ): Promise<'added' | 'updated' | 'conflict'> {
    const state = this.of(guildId)
    const existing = state.subscriptions.get(subscription.endpoint)
    if (existing && existing.memberId !== memberId) {
      return 'conflict'
    }
    state.subscriptions.set(subscription.endpoint, {
      ...subscription,
      memberId,
      sinceSeq: existing?.sinceSeq ?? sinceSeq,
    })
    return existing ? 'updated' : 'added'
  }

  async remove(
    guildId: string,
    memberId: string,
    endpoint: string
  ): Promise<'removed' | 'not_found' | 'conflict'> {
    const state = this.of(guildId)
    const existing = state.subscriptions.get(endpoint)
    if (!existing) {
      return 'not_found'
    }
    if (existing.memberId !== memberId) {
      return 'conflict'
    }
    this.forget(state, endpoint)
    return 'removed'
  }

  async drop(guildId: string, endpoint: string): Promise<boolean> {
    const state = this.of(guildId)
    const existed = state.subscriptions.has(endpoint)
    this.forget(state, endpoint)
    return existed
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number }
  ): Promise<PushSubscriptionPage> {
    const after = page.after
    const sorted = [...this.of(guildId).subscriptions.values()]
      .filter((s) => after === undefined || s.endpoint > after)
      .sort((x, y) => (x.endpoint < y.endpoint ? -1 : 1))
    const subscriptions = sorted.slice(0, page.limit).map((s) => ({ ...s }))
    const last = subscriptions.at(-1)
    return { subscriptions, next: sorted.length > page.limit && last ? last.endpoint : null }
  }

  async claimDelivery(
    guildId: string,
    sealId: string,
    endpoint: string,
    lease: DeliveryLease
  ): Promise<DeliveryClaim> {
    const state = this.of(guildId)
    if (!state.subscriptions.has(endpoint)) {
      return 'done'
    }
    const now = lease.now.getTime()
    const key = `${sealId}|${endpoint}`
    const delivery = state.deliveries.get(key)
    if (!delivery) {
      state.deliveries.set(key, {
        state: 'pending',
        attempts: 1,
        leaseUntil: now + lease.leaseMs,
      })
      return 'claimed'
    }
    if (delivery.state !== 'pending') {
      return 'done'
    }
    if (delivery.leaseUntil > now) {
      return 'busy'
    }
    if (delivery.attempts >= lease.maxAttempts) {
      delivery.state = 'failed'
      return 'done'
    }
    delivery.attempts += 1
    delivery.leaseUntil = now + lease.leaseMs
    return 'claimed'
  }

  async completeDelivery(guildId: string, sealId: string, endpoint: string): Promise<void> {
    const delivery = this.of(guildId).deliveries.get(`${sealId}|${endpoint}`)
    if (delivery) {
      delivery.state = 'sent'
    }
  }

  async releaseDelivery(
    guildId: string,
    sealId: string,
    endpoint: string,
    now: Date
  ): Promise<void> {
    const delivery = this.of(guildId).deliveries.get(`${sealId}|${endpoint}`)
    if (delivery?.state === 'pending') {
      delivery.leaseUntil = now.getTime()
    }
  }

  async cursor(guildId: string): Promise<number> {
    return this.of(guildId).cursor
  }

  async advanceCursor(guildId: string, seq: number): Promise<void> {
    const state = this.of(guildId)
    state.cursor = Math.max(state.cursor, seq)
  }

  async acquireDispatchLease(
    guildId: string,
    holder: string,
    lease: { now: Date; leaseMs: number }
  ): Promise<boolean> {
    const state = this.of(guildId)
    const now = lease.now.getTime()
    if (state.dispatch && state.dispatch.holder !== holder && state.dispatch.until > now) {
      return false
    }
    state.dispatch = { holder, until: now + lease.leaseMs }
    return true
  }

  async releaseDispatchLease(guildId: string, holder: string): Promise<void> {
    const state = this.of(guildId)
    if (state.dispatch?.holder === holder) {
      state.dispatch = undefined
    }
  }

  async guildsWithDevices(after: string | undefined, limit: number): Promise<string[]> {
    return [...this.guilds]
      .filter(([id, state]) => state.subscriptions.size > 0 && (after === undefined || id > after))
      .map(([id]) => id)
      .sort()
      .slice(0, limit)
  }
}
