import { createECDH } from 'node:crypto'

/** A base64url VAPID key pair and subject, shaped like the `VAPID_*` env settings. */
export type VapidKeys = { publicKey: string; privateKey: string; subject: string }

/**
 * A fresh P-256 VAPID key pair for tests. `privateScalar` pins the private key (32 bytes) so a
 * test can reproduce a specific key.
 */
export function vapidKeys(privateScalar?: Uint8Array): VapidKeys {
  const ecdh = createECDH('prime256v1')
  if (privateScalar) {
    ecdh.setPrivateKey(privateScalar)
  } else {
    ecdh.generateKeys()
  }
  return {
    publicKey: ecdh.getPublicKey().toString('base64url'),
    privateKey: ecdh.getPrivateKey().toString('base64url'),
    subject: 'mailto:ops@guild.example',
  }
}
