import { S3ObjectStore } from './adapters/s3-object-store'
import { MAX_ARTIFACT_BYTES, websocket } from './app'
import { compose } from './composition'
import { startDispatchLoop } from './dispatch-loop'
import { loadEnv } from './env'
import { listenOptions } from './server-config'
import { withWebApp } from './web-static'
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

// A global bar left half-announced by a crash is finished now (idempotent per guild and bar).
await adapters.gates.resumeAnnouncements()

// Off unless DISPATCH_INTERVAL_MS is set. A plain setInterval is fine: the loop keeps no durable
// state (the queue and Seals are the state, and dispatch is idempotent), so nothing is lost on restart.
const { research } = adapters
const loop =
  env.DISPATCH_INTERVAL_MS === undefined
    ? null
    : startDispatchLoop({
        dispatcher: adapters.dispatcher,
        guildIds: (after, limit) => adapters.db.guildIds(after, limit),
        intervalMs: env.DISPATCH_INTERVAL_MS,
        timer: {
          schedule: (fn, ms) => setInterval(fn, ms),
          clear: (handle) => clearInterval(handle),
        },
        onError: (error, guildId) => {
          process.stderr.write(
            `dispatch pass failed: guild=${guildId ?? 'all'} ${error instanceof Error ? error.name : 'unknown'}\n`
          )
        },
      })

// Research slots and spends a crash left behind are released on their own timer, whether or not
// the dispatch loop is on (the sweep is idempotent and keeps no state here).
const RESEARCH_SWEEP_MS = 60_000
const researchSweep = research
  ? startDispatchLoop({
      guildSweeps: [(guildId) => research.sweep(guildId)],
      guildIds: (after, limit) => adapters.db.guildIds(after, limit),
      intervalMs: RESEARCH_SWEEP_MS,
      timer: {
        schedule: (fn, ms) => setInterval(fn, ms),
        clear: (handle) => clearInterval(handle),
      },
      onError: (error, guildId) => {
        process.stderr.write(
          `research sweep failed: guild=${guildId ?? 'all'} ${error instanceof Error ? error.name : 'unknown'}\n`
        )
      },
    })
  : null

// Unanswered Inquiries past their deadline are expired on their own timer (idempotent per guild).
const INQUIRY_SWEEP_MS = 60_000
const inquirySweep = startDispatchLoop({
  guildSweeps: [(guildId) => adapters.inquiries.expireOverdue(guildId, adapters.clock.now())],
  guildIds: (after, limit) => adapters.db.guildIds(after, limit),
  intervalMs: INQUIRY_SWEEP_MS,
  timer: {
    schedule: (fn, ms) => setInterval(fn, ms),
    clear: (handle) => clearInterval(handle),
  },
  onError: (error, guildId) => {
    process.stderr.write(
      `inquiry sweep failed: guild=${guildId ?? 'all'} ${error instanceof Error ? error.name : 'unknown'}\n`
    )
  },
})

// Always registered, loop or not: the background announcements of a global bar end at a page
// boundary and what they left untold is finished by the next boot.
const shutdown = () => {
  void Promise.allSettled([
    loop?.stop(),
    researchSweep?.stop(),
    inquirySweep.stop(),
    adapters.gates.stop(),
  ]).finally(() => process.exit(0))
}
process.once('SIGTERM', shutdown)
process.once('SIGINT', shutdown)

// Bun rejects larger bodies before the app sees them; the slack covers non-artifact JSON bodies.
export default {
  ...listenOptions(env, MAX_ARTIFACT_BYTES + 1024 * 1024),
  fetch: (env.WEB_DIST ? withWebApp(app, env.WEB_DIST) : app).fetch,
  websocket,
}
