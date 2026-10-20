/** One browser push subscription of the Guild Master's device (keys are base64url, as the browser gives them). */
export interface PushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/** A subscription with the member (the Guild Master) who owns the device. */
export interface StoredPushSubscription extends PushSubscription {
  memberId: string
  /** The guild's event seq when the device subscribed: earlier events are never pushed to it. */
  sinceSeq: number
}

/** A page of subscriptions in endpoint order; `next` is the cursor for the following page, null at the end. */
export interface PushSubscriptionPage {
  subscriptions: StoredPushSubscription[]
  next: string | null
}

/** How a delivery claim is leased. */
export interface DeliveryLease {
  now: Date
  /** How long a claim stays `pending` before a crashed sender's claim may be retried. */
  leaseMs: number
  /** Claims allowed per (Seal, device); one more attempt marks the delivery failed. */
  maxAttempts: number
}

/**
 * `claimed`: the caller must send now. `busy`: another sender holds an unexpired claim.
 * `done`: already sent, failed for good, or the subscription is gone; nothing to send.
 */
export type DeliveryClaim = 'claimed' | 'busy' | 'done'

/**
 * Port for push state of one guild: the Guild Master's device subscriptions, the state of each
 * (Seal, subscription) delivery, and how far the guild's event log has been scanned for Seal
 * requests. State lives in the adapter, never in process memory of the app.
 */
export interface PushStore {
  /**
   * Stores a subscription owned by `memberId`, recording `sinceSeq` the first time. The same
   * endpoint again by the same member replaces its keys (`updated`); another member's endpoint
   * is left untouched (`conflict`).
   */
  add(
    guildId: string,
    memberId: string,
    subscription: PushSubscription,
    sinceSeq: number
  ): Promise<'added' | 'updated' | 'conflict'>
  /** Removes `memberId`'s subscription and its deliveries; `conflict` for another member's. */
  remove(
    guildId: string,
    memberId: string,
    endpoint: string
  ): Promise<'removed' | 'not_found' | 'conflict'>
  /** Removes a subscription whatever its owner (the push service dropped it); true when it existed. */
  drop(guildId: string, endpoint: string): Promise<boolean>
  /** A page of the guild's subscriptions after the `after` endpoint cursor. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<PushSubscriptionPage>
  /**
   * Claims the delivery of `sealId` to `endpoint` as `pending` under a lease. Exactly one of any
   * number of same-moment callers gets `claimed`. A `pending` claim whose lease expired is
   * claimed again (a crashed sender) until `maxAttempts`, after which it becomes failed (`done`).
   */
  claimDelivery(
    guildId: string,
    sealId: string,
    endpoint: string,
    lease: DeliveryLease
  ): Promise<DeliveryClaim>
  /** Marks a claimed delivery sent. */
  completeDelivery(guildId: string, sealId: string, endpoint: string): Promise<void>
  /** Gives up a claim after a transient failure so the next claim (at or after `now`) retries. */
  releaseDelivery(guildId: string, sealId: string, endpoint: string, now: Date): Promise<void>
  /** The highest event seq already dispatched for the guild, 0 when none. */
  cursor(guildId: string): Promise<number>
  /** Raises the cursor to `seq`; it never moves backwards. */
  advanceCursor(guildId: string, seq: number): Promise<void>
  /**
   * Takes (or renews, for the same `holder`) the guild's dispatch lease until `now + leaseMs`.
   * True when `holder` holds it; false while another holder's lease has not expired. An expired
   * lease is taken over. This is one short atomic write: nothing stays open while a dispatch runs.
   */
  acquireDispatchLease(
    guildId: string,
    holder: string,
    lease: { now: Date; leaseMs: number }
  ): Promise<boolean>
  /** Gives the lease back if `holder` still holds it. */
  releaseDispatchLease(guildId: string, holder: string): Promise<void>
  /**
   * Guilds that have at least one push subscription, in id order after `after` (for the start-up
   * sweep). Opaque guild ids only; it reads no tenant data.
   */
  guildsWithDevices(after: string | undefined, limit: number): Promise<string[]>
}
