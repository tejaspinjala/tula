import type { Db } from '../db/client'
import type {
  DeliveryClaim,
  DeliveryLease,
  PushStore,
  PushSubscription,
  PushSubscriptionPage,
} from '../ports/push-store'

const todo = (..._used: unknown[]): never => {
  throw new Error('not implemented')
}

/** Postgres {@link PushStore}. */
export class PgPushStore implements PushStore {
  constructor(private readonly db: Db) {}

  async add(
    _guildId: string,
    _memberId: string,
    _subscription: PushSubscription,
    _sinceSeq: number
  ): Promise<'added' | 'updated' | 'conflict'> {
    return todo(this.db)
  }

  async remove(
    _guildId: string,
    _memberId: string,
    _endpoint: string
  ): Promise<'removed' | 'not_found' | 'conflict'> {
    return todo()
  }

  async drop(_guildId: string, _endpoint: string): Promise<boolean> {
    return todo()
  }

  async list(
    _guildId: string,
    _page: { after?: string; limit: number }
  ): Promise<PushSubscriptionPage> {
    return todo()
  }

  async claimDelivery(
    _guildId: string,
    _sealId: string,
    _endpoint: string,
    _lease: DeliveryLease
  ): Promise<DeliveryClaim> {
    return todo()
  }

  async completeDelivery(_guildId: string, _sealId: string, _endpoint: string): Promise<void> {
    todo()
  }

  async releaseDelivery(_guildId: string, _sealId: string, _endpoint: string): Promise<void> {
    todo()
  }

  async cursor(_guildId: string): Promise<number> {
    return todo()
  }

  async advanceCursor(_guildId: string, _seq: number): Promise<void> {
    todo()
  }

  async withDispatchLock<T>(_guildId: string, _fn: () => Promise<T>): Promise<T> {
    return todo()
  }
}
