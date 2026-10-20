import type { PushSubscription } from '../ports/push-store'

/** Fixed randomness for known-answer tests; production draws both fresh per message. */
export interface PushEntropy {
  /** 16-byte salt. */
  salt?: Buffer
  /** 32-byte ephemeral P-256 private key. */
  ephemeralPrivateKey?: Buffer
}

/** RFC 8291 aes128gcm: encrypts `plaintext` for the device in one record. */
export function encryptPayload(
  _subscription: Pick<PushSubscription, 'p256dh' | 'auth'>,
  _plaintext: Buffer,
  _entropy: PushEntropy = {}
): Buffer {
  throw new Error('not implemented')
}
