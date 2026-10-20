import { S3ObjectStore } from './adapters/s3-object-store'
import { MAX_ARTIFACT_BYTES, websocket } from './app'
import { compose } from './composition'
import { loadEnv } from './env'

const env = loadEnv()
const { app, adapters } = await compose()
if (env.OBJECT_STORE_CREATE_BUCKET && adapters.objectStore instanceof S3ObjectStore) {
  await adapters.objectStore.ensureBucket()
}

// Bun rejects larger bodies before the app sees them; the slack covers non-artifact JSON bodies.
export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: MAX_ARTIFACT_BYTES + 1024 * 1024,
}
