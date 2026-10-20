import { S3Client } from 'bun'
import { S3ObjectStore } from '../src/adapters/s3-object-store'
import { objectStoreContract } from '../src/ports/object-store.contract'

const endpoint = process.env.OBJECT_STORE_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.OBJECT_STORE_ACCESS_KEY ?? 'guildhall'
const secretAccessKey = process.env.OBJECT_STORE_SECRET_KEY ?? 'guildhall-dev-secret'

objectStoreContract('MinIO', async () => {
  // A fresh bucket per store keeps object counts exact.
  const bucket = `contract-${crypto.randomUUID().slice(0, 8)}`
  const store = new S3ObjectStore({ endpoint, bucket, accessKeyId, secretAccessKey })
  await store.ensureBucket()
  const client = new S3Client({ endpoint, bucket, accessKeyId, secretAccessKey })
  return { store, countObjects: async () => (await client.list()).contents?.length ?? 0 }
})
