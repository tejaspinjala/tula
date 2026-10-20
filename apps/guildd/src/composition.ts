import type { Hono } from 'hono'
import { S3ObjectStore } from './adapters/s3-object-store'
import { SystemClock } from './adapters/system-clock'
import { type AppDeps, createApp } from './app'
import { createDb } from './db/client'
import { loadEnv } from './env'

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass a clock, an object store and a Db on a throwaway database,
 * production none. The Db has no memory adapter by design: tenancy is enforced by Postgres, so
 * contract tests run against real Postgres.
 */
export function compose(overrides: Partial<AppDeps> = {}): { app: Hono; adapters: AppDeps } {
  const { db, devGuildHeader, objectStore } =
    overrides.db && overrides.devGuildHeader !== undefined && overrides.objectStore
      ? {
          db: overrides.db,
          devGuildHeader: overrides.devGuildHeader,
          objectStore: overrides.objectStore,
        }
      : fromEnv(overrides)
  const adapters: AppDeps = {
    clock: new SystemClock(),
    ...overrides,
    db,
    devGuildHeader,
    objectStore,
  }
  return { app: createApp(adapters), adapters }
}

function fromEnv(
  overrides: Partial<AppDeps>
): Pick<AppDeps, 'db' | 'devGuildHeader' | 'objectStore'> {
  const env = loadEnv()
  return {
    db: overrides.db ?? createDb(env.APP_DATABASE_URL),
    devGuildHeader: overrides.devGuildHeader ?? env.DEV_GUILD_HEADER,
    objectStore:
      overrides.objectStore ??
      new S3ObjectStore({
        endpoint: env.OBJECT_STORE_ENDPOINT,
        bucket: env.OBJECT_STORE_BUCKET,
        accessKeyId: env.OBJECT_STORE_ACCESS_KEY,
        secretAccessKey: env.OBJECT_STORE_SECRET_KEY,
      }),
  }
}
