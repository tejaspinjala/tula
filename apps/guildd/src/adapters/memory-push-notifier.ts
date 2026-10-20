import type { PushNotifier, PushOutcome, PushPayload } from '../ports/push-notifier'
import type { PushSubscription } from '../ports/push-store'

/** Memory {@link PushNotifier}. */
export class MemoryPushNotifier implements PushNotifier {
  /** Makes sends to `endpoint` answer `gone`. */
  markGone(_endpoint: string): void {
    throw new Error('not implemented')
  }

  /** Payloads accepted for `endpoint`. */
  sentTo(_endpoint: string): PushPayload[] {
    throw new Error('not implemented')
  }

  async send(_subscription: PushSubscription, _payload: PushPayload): Promise<PushOutcome> {
    throw new Error('not implemented')
  }
}
