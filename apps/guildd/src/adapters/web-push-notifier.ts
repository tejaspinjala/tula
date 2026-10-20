import type { PushNotifier, PushOutcome, PushPayload } from '../ports/push-notifier'
import type { PushSubscription } from '../ports/push-store'

/** The slice of `fetch` the notifier uses; tests pass a fake push service. */
export type PushFetch = (url: string, init: RequestInit) => Promise<Response>

/** Settings for {@link WebPushNotifier}. */
export interface WebPushOptions {
  /** VAPID public key: base64url of the 65-byte uncompressed P-256 point. */
  publicKey: string
  /** VAPID private key: base64url of the 32-byte scalar. */
  privateKey: string
  /** VAPID `sub` claim: a `mailto:` or `https:` contact for the push service. */
  subject: string
  fetch?: PushFetch | undefined
  /** Per-attempt timeout; defaults to 5000 ms. */
  timeoutMs?: number | undefined
  /** Retries after the first attempt; defaults to 2. */
  retries?: number | undefined
  /** Base delay of the jittered backoff; defaults to 200 ms. */
  baseDelayMs?: number | undefined
  sleep?: ((ms: number) => Promise<void>) | undefined
  random?: (() => number) | undefined
  now?: (() => Date) | undefined
}

/** Web Push over VAPID (RFC 8292) with aes128gcm payload encryption (RFC 8291). */
export class WebPushNotifier implements PushNotifier {
  constructor(private readonly options: WebPushOptions) {}

  async send(_subscription: PushSubscription, _payload: PushPayload): Promise<PushOutcome> {
    throw new Error(`not implemented ${this.options.subject}`)
  }
}
