import { createCipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import type { PushSubscription } from '../ports/push-store'

/** Fixed randomness for known-answer tests; production draws both fresh per message. */
export interface PushEntropy {
  /** 16-byte salt. */
  salt?: Buffer
  /** 32-byte ephemeral P-256 private key. */
  ephemeralPrivateKey?: Buffer
}

const RECORD_SIZE = 4096

const hkdf = (ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer =>
  Buffer.from(hkdfSync('sha256', ikm, salt, info, length))

/**
 * RFC 8291 aes128gcm: encrypts `plaintext` for the device in one record (data, then the 0x02
 * last-record delimiter), with a fresh ephemeral key and salt unless `entropy` fixes them.
 * Throws when the device's public key is not a valid P-256 point.
 */
export function encryptPayload(
  subscription: Pick<PushSubscription, 'p256dh' | 'auth'>,
  plaintext: Buffer,
  entropy: PushEntropy = {}
): Buffer {
  const uaPublic = Buffer.from(subscription.p256dh, 'base64url')
  const authSecret = Buffer.from(subscription.auth, 'base64url')
  const ephemeral = createECDH('prime256v1')
  if (entropy.ephemeralPrivateKey) {
    ephemeral.setPrivateKey(entropy.ephemeralPrivateKey)
  } else {
    ephemeral.generateKeys()
  }
  const asPublic = ephemeral.getPublicKey()
  const shared = ephemeral.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = hkdf(shared, authSecret, keyInfo, 32)
  const salt = entropy.salt ?? randomBytes(16)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  const header = Buffer.alloc(21)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header.writeUInt8(asPublic.length, 20)
  return Buffer.concat([header, asPublic, sealed])
}
