import { S3ObjectStore } from './adapters/s3-object-store'
import { MAX_ARTIFACT_BYTES, websocket } from './app'
import { compose } from './composition'
import { startDispatchLoop } from './dispatch-loop'
import { loadEnv } from './env'
import { assertBackpressureSupported } from './ws-support'

const env = loadEnv()
await assertBackpressureSupported()
const { app, adapters } = await compose()
if (env.OBJECT_STORE_CREATE_BUCKET && adapters.objectStore instanceof S3ObjectStore) {
  await adapters.objectStore.ensureBucket()
}

// Seal requests push the Guild Master's devices; a failed dispatch is retried at the next wake.
await adapters.pushRelay.start((error) => {
  process.stderr.write(
    `seal push dispatch failed: ${error instanceof Error ? error.name : 'unknown'}\n`
  )
})

// Off unless DISPATCH_INTERVAL_MS is set. A plain setInterval is fine: the loop keeps no durable
// state (the queue and Seals are the state, and dispatch is idempotent), so nothing is lost on restart.
if (env.DISPATCH_INTERVAL_MS !== undefined) {
  const loop = startDispatchLoop({
    dispatcher: adapters.dispatcher,
    guildIds: (after, limit) => adapters.db.guildIds(after, limit),
    intervalMs: env.DISPATCH_INTERVAL_MS,
    timer: {
      schedule: (fn, ms) => setInterval(fn, ms),
      clear: (handle) => clearInterval(handle),
    },
    onError: (error) => {
      process.stderr.write(
        `dispatch pass failed: ${error instanceof Error ? error.name : 'unknown'}\n`
      )
    },
  })
  const shutdown = () => {
    void loop.stop().finally(() => process.exit(0))
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
}

// Bun rejects larger bodies before the app sees them; the slack covers non-artifact JSON bodies.
export default {
  port: env.PORT,
  fetch: app.fetch,
  websocket,
  maxRequestBodySize: MAX_ARTIFACT_BYTES + 1024 * 1024,
}
