const enc = new TextEncoder()
const dec = new TextDecoder()
const NONCE_BYTES = 12

/** A fresh random 256-bit per-guild data key. */
export function newDataKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32))
}

async function importKey(dataKey: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', Uint8Array.from(dataKey), 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

function aad(guildId: string, ref: string): Uint8Array<ArrayBuffer> {
  return enc.encode(`${guildId}/${ref}`)
}

/**
 * AES-256-GCM seals `value` under `dataKey` with a fresh random nonce, binding guild and ref as
 * associated data. Returns nonce followed by ciphertext and tag.
 */
export async function seal(
  dataKey: Uint8Array,
  guildId: string,
  ref: string,
  value: string
): Promise<Uint8Array> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
  const body = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: aad(guildId, ref) },
    await importKey(dataKey),
    enc.encode(value)
  )
  const out = new Uint8Array(NONCE_BYTES + body.byteLength)
  out.set(nonce)
  out.set(new Uint8Array(body), NONCE_BYTES)
  return out
}

/** Reverses {@link seal}; rejects on tampering or when guild or ref differ. */
export async function open(
  dataKey: Uint8Array,
  guildId: string,
  ref: string,
  sealed: Uint8Array
): Promise<string> {
  const body = await crypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Uint8Array.from(sealed.subarray(0, NONCE_BYTES)),
      additionalData: aad(guildId, ref),
    },
    await importKey(dataKey),
    Uint8Array.from(sealed.subarray(NONCE_BYTES))
  )
  return dec.decode(body)
}
