import { createPrivateKey, type KeyObject, sign } from 'node:crypto'
import {
  type PushNotifier,
  type PushOutcome,
  type PushPayload,
  PushRejectedError,
} from '../ports/push-notifier'
import type { PushSubscription } from '../ports/push-store'
import { isPushEndpoint, PUSH_SERVICE_HOSTS } from '../push-endpoint'
import { encryptPayload } from './web-push-crypto'

/** The slice of `fetch` the notifier uses; tests pass a fake push service. */
export type PushFetch = (url: string, init: RequestInit) => Promise<Response>

/** Settings for {@link WebPushNotifier}. */
export interface WebPushOptions {
  /** VAPID public key: base64url of the 65-byte uncompressed P-256 point. */
  publicKey: string
  /** VAPID private key: base64url of the 32-byte scalar. Never logged or put in an error. */
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
  /** Push service hosts a send may reach; tests only, production uses the fixed list. */
  allowedHosts?: readonly string[] | undefined
}

const JWT_TTL_SECONDS = 12 * 3600
const PUSH_TTL_SECONDS = 24 * 3600

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

/** Thrown when the push service stays unavailable (transient); carries no key material. */
export class PushUnavailableError extends Error {
  constructor(readonly status: number | null) {
    super('push_unavailable')
    this.name = 'PushUnavailableError'
  }
}

/**
 * Web Push over VAPID (RFC 8292) with aes128gcm payload encryption (RFC 8291), on `node:crypto`
 * and `fetch` only. Every send re-checks that the endpoint is https on a known push service
 * (never an IP literal or internal name) and never follows a redirect. Each attempt has a
 * timeout; 429, 5xx and network failures are retried a bounded number of times with jittered
 * exponential backoff and then throw {@link PushUnavailableError}. 404 and 410 mean the
 * subscription is gone. Anything else permanent (bad key, other 4xx, 3xx) throws
 * {@link PushRejectedError}.
 */
export class WebPushNotifier implements PushNotifier {
  private readonly signingKey: KeyObject
  private readonly fetchImpl: PushFetch
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly baseDelayMs: number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly random: () => number
  private readonly allowedHosts: readonly string[]

  constructor(private readonly options: WebPushOptions) {
    const point = Buffer.from(options.publicKey, 'base64url')
    this.signingKey = createPrivateKey({
      key: {
        kty: 'EC',
        crv: 'P-256',
        d: options.privateKey,
        x: b64(point.subarray(1, 33)),
        y: b64(point.subarray(33, 65)),
      },
      format: 'jwk',
    })
    this.fetchImpl = options.fetch ?? ((url, init) => fetch(url, init))
    this.timeoutMs = options.timeoutMs ?? 5000
    this.retries = options.retries ?? 2
    this.baseDelayMs = options.baseDelayMs ?? 200
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.random = options.random ?? Math.random
    this.allowedHosts = options.allowedHosts ?? PUSH_SERVICE_HOSTS
  }

  async send(subscription: PushSubscription, payload: PushPayload): Promise<PushOutcome> {
    if (!isPushEndpoint(subscription.endpoint, this.allowedHosts)) {
      throw new PushRejectedError('endpoint_not_allowed')
    }
    let body: Buffer
    try {
      body = encryptPayload(subscription, Buffer.from(JSON.stringify(payload)))
    } catch {
      throw new PushRejectedError('bad_device_key')
    }
    let lastStatus: number | null = null
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      if (attempt > 0) {
        await this.sleep(this.baseDelayMs * 2 ** (attempt - 1) * (0.5 + this.random()))
      }
      const status = await this.attempt(subscription.endpoint, body)
      if (status !== null && status >= 200 && status < 300) {
        return 'sent'
      }
      if (status === 404 || status === 410) {
        return 'gone'
      }
      lastStatus = status
      if (status !== null && status !== 429 && status < 500) {
        throw new PushRejectedError(`status_${status}`)
      }
    }
    throw new PushUnavailableError(lastStatus)
  }

  /** One timed attempt; null when the network failed or the timeout fired. */
  private async attempt(endpoint: string, body: Uint8Array): Promise<number | null> {
    try {
      const res = await this.fetchImpl(endpoint, {
        method: 'POST',
        headers: {
          authorization: this.authorization(endpoint),
          'content-encoding': 'aes128gcm',
          'content-type': 'application/octet-stream',
          ttl: String(PUSH_TTL_SECONDS),
          urgency: 'high',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.timeoutMs),
      })
      return res.status
    } catch {
      return null
    }
  }

  private authorization(endpoint: string): string {
    const header = b64(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })))
    const claims = b64(
      Buffer.from(
        JSON.stringify({
          aud: new URL(endpoint).origin,
          exp: Math.floor(Date.now() / 1000) + JWT_TTL_SECONDS,
          sub: this.options.subject,
        })
      )
    )
    const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
      key: this.signingKey,
      dsaEncoding: 'ieee-p1363',
    })
    return `vapid t=${header}.${claims}.${b64(signature)}, k=${this.options.publicKey}`
  }
}
