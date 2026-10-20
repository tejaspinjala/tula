import { S3Client } from 'bun'
import { hashBytes, type ObjectHead, type ObjectStore } from '../ports/object-store'

/** Connection settings for {@link S3ObjectStore}. */
export interface S3ObjectStoreOptions {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

const REGION = 'us-east-1'

function hmac(key: Uint8Array | string, data: string): Uint8Array {
  return new Uint8Array(new Bun.CryptoHasher('sha256', key).update(data).digest())
}

/** {@link ObjectStore} over S3-compatible storage (MinIO in development); keys are `<guild>/<hash>`. */
export class S3ObjectStore implements ObjectStore {
  private readonly client: S3Client

  constructor(private readonly options: S3ObjectStoreOptions) {
    this.client = new S3Client({ ...options, region: REGION })
  }

  /**
   * Creates the bucket if it does not exist (setup for development and tests). Bun's S3 client
   * cannot create buckets, so this signs the one request (SigV4, path style) itself.
   */
  async ensureBucket(): Promise<void> {
    const { endpoint, bucket, accessKeyId, secretAccessKey } = this.options
    const host = new URL(endpoint).host
    const now = new Date().toISOString().replace(/[-:]|\.\d{3}/g, '')
    const day = now.slice(0, 8)
    const payloadHash = hashBytes(new Uint8Array())
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
    const canonical = [
      'PUT',
      `/${bucket}`,
      '',
      `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${now}\n`,
      signedHeaders,
      payloadHash,
    ].join('\n')
    const scope = `${day}/${REGION}/s3/aws4_request`
    const toSign = `AWS4-HMAC-SHA256\n${now}\n${scope}\n${hashBytes(new TextEncoder().encode(canonical))}`
    let key = hmac(`AWS4${secretAccessKey}`, day)
    for (const part of [REGION, 's3', 'aws4_request']) {
      key = hmac(key, part)
    }
    const signature = new Bun.CryptoHasher('sha256', key).update(toSign).digest('hex')
    const res = await fetch(`${endpoint.replace(/\/$/, '')}/${bucket}`, {
      method: 'PUT',
      headers: {
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': now,
        authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
      },
      signal: AbortSignal.timeout(10_000),
    })
    // 409: the bucket already exists (and is ours).
    if (!res.ok && res.status !== 409) {
      throw new Error(`could not create bucket ${bucket}: ${res.status}`)
    }
  }

  async put(guildId: string, bytes: Uint8Array): Promise<string> {
    const hash = hashBytes(bytes)
    await this.client.write(`${guildId}/${hash}`, bytes)
    return hash
  }

  async get(guildId: string, hash: string): Promise<Uint8Array | null> {
    const file = this.client.file(`${guildId}/${hash}`)
    return (await file.exists()) ? await file.bytes() : null
  }

  async head(guildId: string, hash: string): Promise<ObjectHead | null> {
    const file = this.client.file(`${guildId}/${hash}`)
    return (await file.exists()) ? { size: (await file.stat()).size } : null
  }
}
