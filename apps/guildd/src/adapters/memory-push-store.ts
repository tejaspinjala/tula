import type { PushStore, PushSubscription, PushSubscriptionPage } from '../ports/push-store'

interface GuildPush {
  subscriptions: Map<string, PushSubscription>
  claims: Set<string>
  cursor: number
}

/**
 * Memory {@link PushStore}. Every operation checks and writes with no `await` between, so claims
 * are atomic. State is per instance.
 */
export class MemoryPushStore implements PushStore {
  private readonly guilds = new Map<string, GuildPush>()

  private of(guildId: string): GuildPush {
    let state = this.guilds.get(guildId)
    if (!state) {
      state = { subscriptions: new Map(), claims: new Set(), cursor: 0 }
      this.guilds.set(guildId, state)
    }
    return state
  }

  async add(guildId: string, subscription: PushSubscription): Promise<void> {
    this.of(guildId).subscriptions.set(subscription.endpoint, { ...subscription })
  }

  async remove(guildId: string, endpoint: string): Promise<boolean> {
    const state = this.of(guildId)
    for (const claim of state.claims) {
      if (claim.endsWith(`|${endpoint}`)) {
        state.claims.delete(claim)
      }
    }
    return state.subscriptions.delete(endpoint)
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

  async claimDelivery(guildId: string, sealId: string, endpoint: string): Promise<boolean> {
    const state = this.of(guildId)
    const key = `${sealId}|${endpoint}`
    if (!state.subscriptions.has(endpoint) || state.claims.has(key)) {
      return false
    }
    state.claims.add(key)
    return true
  }

  async releaseDelivery(guildId: string, sealId: string, endpoint: string): Promise<void> {
    this.of(guildId).claims.delete(`${sealId}|${endpoint}`)
  }

  async cursor(guildId: string): Promise<number> {
    return this.of(guildId).cursor
  }

  async advanceCursor(guildId: string, seq: number): Promise<void> {
    const state = this.of(guildId)
    state.cursor = Math.max(state.cursor, seq)
  }
}
