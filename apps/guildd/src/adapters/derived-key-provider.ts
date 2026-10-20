import type { KeyProvider } from '../ports/key-provider'

const encoder = new TextEncoder()
const NONCE_BYTES = 12
const TAG_BYTES = 16

/** Hex encoding of `bytes`, lowercase. */
function toHex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/**
 * Shared {@link KeyProvider} logic over a 32-byte master secret held in process memory by the
 * subclass. Per-guild keys come from HKDF-SHA256(master, info = purpose and guild); wrapping is
 * AES-256-GCM with the guild id as associated data. Subclasses only decide where the master lives.
 */
export abstract class DerivedKeyProvider implements KeyProvider {
  private readonly master: Promise<CryptoKey>

  protected constructor(master: Uint8Array) {
    if (master.byteLength !== 32) {
      throw new Error('master key must be exactly 32 bytes')
    }
    this.master = crypto.subtle.importKey('raw', master.slice(), 'HKDF', false, ['deriveBits'])
  }

  private async derive(info: string): Promise<ArrayBuffer> {
    return crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: encoder.encode(info) },
      await this.master,
      256
    )
  }

  /** @inheritdoc */
  async macFor(guildId: string, purpose: string): Promise<(data: Uint8Array) => Promise<string>> {
    const raw = await this.derive(`mac:${purpose}:${guildId}`)
    const key = await crypto.subtle.importKey(
      'raw',
      raw,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    )
    return async (data) => toHex(await crypto.subtle.sign('HMAC', key, data.slice()))
  }

  /** @inheritdoc */
  async mac(guildId: string, purpose: string, data: Uint8Array): Promise<string> {
    return (await this.macFor(guildId, purpose))(data)
  }

  private async wrapKey(guildId: string): Promise<CryptoKey> {
    return crypto.subtle.importKey('raw', await this.derive(`wrap:${guildId}`), 'AES-GCM', false, [
      'encrypt',
      'decrypt',
    ])
  }

  /** @inheritdoc */
  async wrap(guildId: string, plaintext: Uint8Array): Promise<Uint8Array> {
    const iv = crypto.getRandomValues(new Uint8Array(NONCE_BYTES))
    const sealed = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(guildId) },
      await this.wrapKey(guildId),
      plaintext.slice()
    )
    const out = new Uint8Array(NONCE_BYTES + sealed.byteLength)
    out.set(iv)
    out.set(new Uint8Array(sealed), NONCE_BYTES)
    return out
  }

  /** @inheritdoc */
  async unwrap(guildId: string, wrapped: Uint8Array): Promise<Uint8Array> {
    if (wrapped.byteLength < NONCE_BYTES + TAG_BYTES) {
      throw new Error('wrapped value is too short')
    }
    const opened = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: wrapped.slice(0, NONCE_BYTES),
        additionalData: encoder.encode(guildId),
      },
      await this.wrapKey(guildId),
      wrapped.slice(NONCE_BYTES)
    )
    return new Uint8Array(opened)
  }
}
