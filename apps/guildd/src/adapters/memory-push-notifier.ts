import type { PushNotifier, PushOutcome, PushPayload } from '../ports/push-notifier'
import type { PushSubscription } from '../ports/push-store'

/**
 * Memory {@link PushNotifier}: records every accepted send so tests can assert on it. An endpoint
 * marked gone answers `gone`, and a scripted failure makes the next sends throw.
 */
export class MemoryPushNotifier implements PushNotifier {
  private readonly sent = new Map<string, PushPayload[]>()
  private readonly gone = new Set<string>()
  private failures = 0

  /** Makes sends to `endpoint` answer `gone`. */
  markGone(endpoint: string): void {
    this.gone.add(endpoint)
  }

  /** Makes the next `count` sends throw, as an exhausted retry would. */
  failNext(count: number): void {
    this.failures = count
  }

  /** Payloads accepted for `endpoint`, in order. */
  sentTo(endpoint: string): PushPayload[] {
    return [...(this.sent.get(endpoint) ?? [])]
  }

  /** Every accepted send across endpoints. */
  get sends(): Array<{ endpoint: string; payload: PushPayload }> {
    return [...this.sent].flatMap(([endpoint, payloads]) =>
      payloads.map((payload) => ({ endpoint, payload }))
    )
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<PushOutcome> {
    if (this.failures > 0) {
      this.failures -= 1
      throw new Error('push service unavailable')
    }
    if (this.gone.has(subscription.endpoint)) {
      return 'gone'
    }
    const list = this.sent.get(subscription.endpoint) ?? []
    list.push({ sealId: payload.sealId, guildId: payload.guildId })
    this.sent.set(subscription.endpoint, list)
    return 'sent'
  }
}
