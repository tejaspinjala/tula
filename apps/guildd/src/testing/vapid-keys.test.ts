import { expect, test } from 'bun:test'
import { loadVapidEnv } from '../env'
import { vapidKeys } from './vapid-keys'

// About 1 key in 256 has a private scalar whose first byte is zero; getPrivateKey() drops it.
test('a VAPID private key with a leading zero byte is still 32 bytes and accepted', () => {
  const scalar = new Uint8Array(32)
  scalar[31] = 7
  const keys = vapidKeys(scalar)
  expect(Buffer.from(keys.privateKey, 'base64url')).toHaveLength(32)
  expect(
    loadVapidEnv({
      VAPID_PUBLIC_KEY: keys.publicKey,
      VAPID_PRIVATE_KEY: keys.privateKey,
      VAPID_SUBJECT: keys.subject,
    })?.privateKey
  ).toBe(keys.privateKey)
})
