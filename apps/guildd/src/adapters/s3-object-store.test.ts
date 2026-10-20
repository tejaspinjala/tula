import { describe, expect, test } from 'bun:test'
import { S3ObjectStore } from './s3-object-store'

const options = {
  endpoint: 'http://localhost:1',
  bucket: 'some-bucket',
  accessKeyId: 'a',
  secretAccessKey: 's',
}

const respond = (status: number, code?: string) =>
  (async () =>
    new Response(code ? `<Error><Code>${code}</Code></Error>` : '', {
      status,
    })) as unknown as typeof fetch

describe('S3ObjectStore.ensureBucket', () => {
  test('a 409 BucketAlreadyOwnedByYou is success', async () => {
    const store = new S3ObjectStore({ ...options, fetch: respond(409, 'BucketAlreadyOwnedByYou') })
    await store.ensureBucket()
  })

  test('a 409 BucketAlreadyExists (someone else owns it) throws', async () => {
    const store = new S3ObjectStore({ ...options, fetch: respond(409, 'BucketAlreadyExists') })
    await expect(store.ensureBucket()).rejects.toThrow()
  })

  test('a 409 with no recognisable code throws', async () => {
    const store = new S3ObjectStore({ ...options, fetch: respond(409) })
    await expect(store.ensureBucket()).rejects.toThrow()
  })

  test('a 200 is success', async () => {
    await new S3ObjectStore({ ...options, fetch: respond(200) }).ensureBucket()
  })
})
