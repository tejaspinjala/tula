import { expect, test } from 'bun:test'
import { createECDH } from 'node:crypto'
import { decryptRecord } from '../testing/fake-push-service'
import { encryptPayload } from './web-push-crypto'

// RFC 8291 Appendix A: the worked example (all values base64url).
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  asPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  asPublic:
    'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  uaPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  uaPublic:
    'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  auth: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
}

const bytes = (s: string) => Buffer.from(s, 'base64url')

function device(auth = RFC.auth) {
  const ecdh = createECDH('prime256v1')
  ecdh.setPrivateKey(bytes(RFC.uaPrivate))
  return { ecdh, auth: bytes(auth) }
}

test('encryption reproduces the RFC 8291 Appendix A ciphertext exactly', () => {
  const body = encryptPayload(
    { p256dh: RFC.uaPublic, auth: RFC.auth },
    Buffer.from(RFC.plaintext),
    { salt: bytes(RFC.salt), ephemeralPrivateKey: bytes(RFC.asPrivate) }
  )
  expect(body.toString('base64url')).toBe(RFC.body)
})

test('the device side recovers the RFC plaintext', () => {
  expect(decryptRecord(device(), bytes(RFC.body)).toString('utf8')).toBe(RFC.plaintext)
})

test('a wrong auth secret cannot decrypt', () => {
  expect(() => decryptRecord(device('AAAAAAAAAAAAAAAAAAAAAA'), bytes(RFC.body))).toThrow()
})

test('padding is parsed strictly: zeros then a required 0x02', () => {
  const sub = { p256dh: RFC.uaPublic, auth: RFC.auth }
  const body = encryptPayload(sub, Buffer.from('hi'))
  expect(() => decryptRecord(device(), body)).not.toThrow()
  // A record whose delimiter is 0x01 (not the final-record 0x02) must be refused.
  const tampered = Buffer.from(body)
  tampered[tampered.length - 1] = (tampered[tampered.length - 1] ?? 0) ^ 1
  expect(() => decryptRecord(device(), tampered)).toThrow()
})
