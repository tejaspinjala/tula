import type { AuthenticationResponseJSON, RegistrationResponseJSON } from '@simplewebauthn/server'
import { isoBase64URL, isoCBOR } from '@simplewebauthn/server/helpers'
import { z } from 'zod'

const jwk = z.object({ x: z.string(), y: z.string() })

const FLAGS_ASSERT = 0x05 // user present + user verified
const FLAGS_ATTEST = 0x45 // + attested credential data

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint32(value: number): Uint8Array {
  const out = new Uint8Array(4)
  new DataView(out.buffer).setUint32(0, value)
  return out
}

async function sha256(data: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data))
}

/** DER integer from an unsigned big-endian value. */
function derInt(raw: Uint8Array): Uint8Array {
  let start = 0
  while (start < raw.length - 1 && raw[start] === 0) {
    start++
  }
  let body = raw.slice(start)
  if ((body[0] ?? 0) >= 0x80) {
    body = concat(new Uint8Array([0]), body)
  }
  return concat(new Uint8Array([0x02, body.length]), body)
}

/** Converts WebCrypto's raw r||s ECDSA signature to the DER form WebAuthn carries. */
function toDer(raw: Uint8Array): Uint8Array<ArrayBuffer> {
  const half = raw.length / 2
  const body = concat(derInt(raw.slice(0, half)), derInt(raw.slice(half)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

/**
 * A software passkey for tests: an ES256 authenticator that answers registration and sign-in
 * challenges the way a browser would, so adapters verify real WebAuthn payloads.
 */
export class SoftwareAuthenticator {
  private counter = 0
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16))

  private constructor(
    private readonly keys: CryptoKeyPair,
    private readonly x: Uint8Array,
    private readonly y: Uint8Array,
    private readonly rpId: string,
    private readonly origin: string
  ) {}

  /** Creates an authenticator with a fresh key bound to one relying party. */
  static async create(rpId: string, origin: string): Promise<SoftwareAuthenticator> {
    const keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
    ])
    const exported = jwk.parse(await crypto.subtle.exportKey('jwk', keys.publicKey))
    return new SoftwareAuthenticator(
      keys,
      isoBase64URL.toBuffer(exported.x),
      isoBase64URL.toBuffer(exported.y),
      rpId,
      origin
    )
  }

  private clientData(type: string, challenge: string, origin = this.origin) {
    return new TextEncoder().encode(JSON.stringify({ type, challenge, origin, crossOrigin: false }))
  }

  /** Answers a registration ceremony with a `none` attestation. */
  async register(options: { challenge: string }): Promise<RegistrationResponseJSON> {
    const cose = new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [-2, this.x],
      [-3, this.y],
    ])
    const rpIdHash = await sha256(new TextEncoder().encode(this.rpId))
    const credLen = new Uint8Array([0, this.credentialId.length])
    const authData = concat(
      rpIdHash,
      new Uint8Array([FLAGS_ATTEST]),
      uint32(this.counter),
      new Uint8Array(16),
      credLen,
      this.credentialId,
      isoCBOR.encode(cose)
    )
    const attestation = isoCBOR.encode(
      new Map<string, string | Map<string, never> | Uint8Array>([
        ['fmt', 'none'],
        ['attStmt', new Map<string, never>()],
        ['authData', authData],
      ])
    )
    const id = isoBase64URL.fromBuffer(this.credentialId)
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(
          this.clientData('webauthn.create', options.challenge)
        ),
        attestationObject: isoBase64URL.fromBuffer(attestation),
        transports: ['internal'],
      },
    }
  }

  /** Answers a sign-in or re-authentication ceremony; `origin` overrides it to simulate phishing. */
  async assert(
    options: { challenge: string },
    origin?: string
  ): Promise<AuthenticationResponseJSON> {
    this.counter += 1
    const authData = concat(
      await sha256(new TextEncoder().encode(this.rpId)),
      new Uint8Array([FLAGS_ASSERT]),
      uint32(this.counter)
    )
    const clientData = this.clientData('webauthn.get', options.challenge, origin)
    const signed = concat(authData, await sha256(clientData))
    const signature = new Uint8Array(
      await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, this.keys.privateKey, signed)
    )
    const id = isoBase64URL.fromBuffer(this.credentialId)
    return {
      id,
      rawId: id,
      type: 'public-key',
      clientExtensionResults: {},
      response: {
        clientDataJSON: isoBase64URL.fromBuffer(clientData),
        authenticatorData: isoBase64URL.fromBuffer(authData),
        signature: isoBase64URL.fromBuffer(toDer(signature)),
      },
    }
  }
}
