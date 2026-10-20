import type { PushSubscription } from './push-store'

/** What a push carries: ids only, never Seal text. The client fetches details after the tap. */
export interface PushPayload {
  sealId: string
  guildId: string
}

/** `sent`: the push service accepted it. `gone`: it says the subscription no longer exists (404 or 410). */
export type PushOutcome = 'sent' | 'gone'

/**
 * Port for sending a web push to one device subscription. Adapters bound every send by a timeout
 * and retry transient failures a bounded number of times; they throw only when that is exhausted.
 */
export interface PushNotifier {
  /** Sends `payload` to `subscription`. */
  send(subscription: PushSubscription, payload: PushPayload): Promise<PushOutcome>
}
