import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { PushPayload } from '../ports/push-notifier'
import type { PushSubscription } from '../ports/push-store'

/** One request the fake push service received. */
export interface PushRequest {
  url: string
  headers: Record<string, string>
  body: Uint8Array
  redirect: 'follow' | 'manual' | 'error' | undefined
}

const payloadShape = z.object({ sealId: z.string(), guildId: z.string() })

const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString('base64url')

function hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, length))
}

/**
 * The device side of RFC 8291 aes128gcm for a single record: decrypts `body` with the device's
 * ECDH key and auth secret and strips the padding strictly (zero bytes after the data, then a
 * required 0x02 delimiter). Throws when the tag, key or padding is wrong.
 */
export function decryptRecord(
  device: { ecdh: ReturnType<typeof createECDH>; auth: Uint8Array },
  body: Uint8Array
): Buffer {
  const salt = body.subarray(0, 16)
  const idLength = body[20] ?? 0
  const senderPublic = body.subarray(21, 21 + idLength)
  const record = body.subarray(21 + idLength)
  const shared = device.ecdh.computeSecret(senderPublic)
  const keyInfo = Buffer.concat([
    Buffer.from('WebPush: info\0'),
    device.ecdh.getPublicKey(),
    senderPublic,
  ])
  const ikm = hkdf(shared, device.auth, keyInfo, 32)
  const cek = hkdf(ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16)
  const nonce = hkdf(ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12)
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce)
  decipher.setAuthTag(Buffer.from(record.subarray(record.length - 16)))
  const plain = Buffer.concat([
    decipher.update(record.subarray(0, record.length - 16)),
    decipher.final(),
  ])
  let end = plain.length
  while (end > 0 && plain[end - 1] === 0) {
    end -= 1
  }
  if (end === 0 || plain[end - 1] !== 2) {
    throw new Error('bad padding')
  }
  return plain.subarray(0, end - 1)
}

/**
 * Test-only push service plus the browser's side of RFC 8291: it mints subscriptions with real
 * P-256 keys, answers push requests (201, 410 for dropped endpoints, or scripted statuses),
 * and decrypts what arrives so tests can assert on the payload a device would see.
 */
export class FakePushService {
  readonly requests: PushRequest[] = []
  private readonly keys = new Map<string, { ecdh: ReturnType<typeof createECDH>; auth: Buffer }>()
  private readonly gone = new Set<string>()
  private readonly script: Array<number | 'hang'> = []

  /** A subscription for `endpoint` whose keys this service holds. */
  subscribe(endpoint: string): PushSubscription {
    const ecdh = createECDH('prime256v1')
    ecdh.generateKeys()
    const auth = randomBytes(16)
    this.keys.set(endpoint, { ecdh, auth })
    return { endpoint, p256dh: b64(ecdh.getPublicKey()), auth: b64(auth) }
  }

  /** From now on this endpoint answers 410. */
  drop(endpoint: string): void {
    this.gone.add(endpoint)
  }

  /** The next requests answer these statuses in order (`hang` never answers until aborted). */
  respondWith(...statuses: Array<number | 'hang'>): void {
    this.script.push(...statuses)
  }

  /** The fetch the notifier under test is given. */
  readonly fetch = async (url: string, init: RequestInit): Promise<Response> => {
    const headers: Record<string, string> = {}
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value
    })
    const body = init.body instanceof Uint8Array ? init.body : new Uint8Array()
    const scripted = this.script.shift()
    if (scripted === 'hang') {
      const signal = init.signal
      return new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    }
    if (scripted !== undefined) {
      this.requests.push({ url, headers, body, redirect: init.redirect })
      return new Response(null, { status: scripted })
    }
    if (this.gone.has(url)) {
      return new Response(null, { status: 410 })
    }
    this.requests.push({ url, headers, body, redirect: init.redirect })
    return new Response(null, { status: 201 })
  }

  /** Decrypts every request that reached `endpoint` with the device's keys. */
  delivered(endpoint: string): PushPayload[] {
    const device = this.keys.get(endpoint)
    if (!device) {
      return []
    }
    return this.requests
      .filter((r) => r.url === endpoint && r.headers['content-encoding'] === 'aes128gcm')
      .map((r) => payloadShape.parse(JSON.parse(decryptRecord(device, r.body).toString('utf8'))))
  }
}
