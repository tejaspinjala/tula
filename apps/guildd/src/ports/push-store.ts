/** One browser push subscription of the Guild Master's device (keys are base64url, as the browser gives them). */
export interface PushSubscription {
  endpoint: string
  p256dh: string
  auth: string
}

/** A page of subscriptions in endpoint order; `next` is the cursor for the following page, null at the end. */
export interface PushSubscriptionPage {
  subscriptions: PushSubscription[]
  next: string | null
}

/**
 * Port for push state of one guild: the Guild Master's device subscriptions, which (Seal,
 * subscription) deliveries are already claimed, and how far the guild's event log has been
 * scanned for Seal requests. State lives in the adapter, never in process memory of the app.
 */
export interface PushStore {
  /** Stores a subscription; the same endpoint again replaces its keys. */
  add(guildId: string, subscription: PushSubscription): Promise<void>
  /** Removes a subscription (and its delivery claims); true when it existed. */
  remove(guildId: string, endpoint: string): Promise<boolean>
  /** A page of the guild's subscriptions after the `after` endpoint cursor. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<PushSubscriptionPage>
  /**
   * Claims the delivery of `sealId` to `endpoint`. True for exactly one of any number of
   * same-moment calls; false when already claimed or when the subscription no longer exists.
   */
  claimDelivery(guildId: string, sealId: string, endpoint: string): Promise<boolean>
  /** Gives a claim back after a failed send so a later pass may retry it. */
  releaseDelivery(guildId: string, sealId: string, endpoint: string): Promise<void>
  /** The highest event seq already dispatched for the guild, 0 when none. */
  cursor(guildId: string): Promise<number>
  /** Raises the cursor to `seq`; it never moves backwards. */
  advanceCursor(guildId: string, seq: number): Promise<void>
}
