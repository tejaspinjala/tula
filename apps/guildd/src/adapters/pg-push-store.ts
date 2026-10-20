import type { Db } from '../db/client'
import type { PushStore, PushSubscription, PushSubscriptionPage } from '../ports/push-store'

/** Postgres {@link PushStore}. */
export class PgPushStore implements PushStore {
  constructor(private readonly db: Db) {}

  async add(_guildId: string, _subscription: PushSubscription): Promise<void> {
    throw new Error(`not implemented ${typeof this.db}`)
  }

  async remove(_guildId: string, _endpoint: string): Promise<boolean> {
    throw new Error('not implemented')
  }

  async list(
    _guildId: string,
    _page: { after?: string; limit: number }
  ): Promise<PushSubscriptionPage> {
    throw new Error('not implemented')
  }

  async claimDelivery(_guildId: string, _sealId: string, _endpoint: string): Promise<boolean> {
    throw new Error('not implemented')
  }

  async releaseDelivery(_guildId: string, _sealId: string, _endpoint: string): Promise<void> {
    throw new Error('not implemented')
  }

  async cursor(_guildId: string): Promise<number> {
    throw new Error('not implemented')
  }

  async advanceCursor(_guildId: string, _seq: number): Promise<void> {
    throw new Error('not implemented')
  }
}
