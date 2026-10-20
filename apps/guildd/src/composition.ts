import type { Hono } from 'hono'
import { FileKeyProvider } from './adapters/file-key-provider'
import { PgConfigStore } from './adapters/pg-config-store'
import { PgIdentityStore } from './adapters/pg-identity-store'
import { PgNoteStore } from './adapters/pg-note-store'
import { PgSecretStore } from './adapters/pg-secret-store'
import { S3ObjectStore } from './adapters/s3-object-store'
import { SystemClock } from './adapters/system-clock'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { type AppDeps, createApp } from './app'
import { createDb } from './db/client'
import { loadEnv, loadWebauthnEnv } from './env'

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass a clock, an object store, a KeyProvider and a Db on a
 * throwaway database, production none (the key comes from the local key file). The Db has no memory adapter by design: tenancy is enforced by Postgres, so
 * contract tests run against real Postgres.
 */
export async function compose(
  overrides: Partial<AppDeps> = {}
): Promise<{ app: Hono; adapters: AppDeps }> {
  const { db, devGuildHeader, objectStore, keys } =
    overrides.db &&
    overrides.devGuildHeader !== undefined &&
    overrides.objectStore &&
    overrides.keys
      ? {
          db: overrides.db,
          devGuildHeader: overrides.devGuildHeader,
          objectStore: overrides.objectStore,
          keys: overrides.keys,
        }
      : await fromEnv(overrides)
  const clock = overrides.clock ?? new SystemClock()
  const rp = loadWebauthnEnv()
  const adapters: AppDeps = {
    ...overrides,
    clock,
    db,
    devGuildHeader,
    objectStore,
    identity:
      overrides.identity ??
      new WebAuthnIdentityProvider(new PgIdentityStore(db), {
        clock,
        rpId: rp.WEBAUTHN_RP_ID,
        rpName: 'Guildhall',
        origin: rp.WEBAUTHN_ORIGIN,
      }),
    keys,
    config: overrides.config ?? new PgConfigStore(db, keys),
    secrets: overrides.secrets ?? new PgSecretStore(db, keys),
    notes: overrides.notes ?? new PgNoteStore(db, keys),
  }
  return { app: createApp(adapters), adapters }
}

async function fromEnv(
  overrides: Partial<AppDeps>
): Promise<Pick<AppDeps, 'db' | 'devGuildHeader' | 'objectStore' | 'keys'>> {
  const env = loadEnv()
  return {
    keys:
      overrides.keys ??
      (await FileKeyProvider.open(env.KEY_FILE, { create: env.NODE_ENV !== 'production' })),
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
