import { S3ObjectStore } from './adapters/s3-object-store'
import { compose } from './composition'
import { loadEnv } from './env'

const env = loadEnv()
const { app, adapters } = compose()
if (adapters.objectStore instanceof S3ObjectStore) {
  await adapters.objectStore.ensureBucket()
}

export default { port: env.PORT, fetch: app.fetch }
