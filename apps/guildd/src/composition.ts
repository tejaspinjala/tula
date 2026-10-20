import type { Hono } from 'hono'
import { FileCheckpointAnchor } from './adapters/file-checkpoint-anchor'
import { FileKeyProvider } from './adapters/file-key-provider'
import { MemoryCheckpointAnchor } from './adapters/memory-checkpoint-anchor'
import { MemoryClassifier } from './adapters/memory-classifier'
import { PgConfigStore } from './adapters/pg-config-store'
import { PgIdentityStore } from './adapters/pg-identity-store'
import { PgNoteStore } from './adapters/pg-note-store'
import { PgProposalStore } from './adapters/pg-proposal-store'
import { PgQuestQueue } from './adapters/pg-quest-queue'
import { PgRateLimiter } from './adapters/pg-rate-limiter'
import { PgRoutingLog } from './adapters/pg-routing-log'
import { PgSealStore } from './adapters/pg-seal-store'
import { PgSecretStore } from './adapters/pg-secret-store'
import { PgStreamTicketStore } from './adapters/pg-stream-ticket-store'
import { S3ObjectStore } from './adapters/s3-object-store'
import { SystemClock } from './adapters/system-clock'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { type AppDeps, createApp } from './app'
import { createDb } from './db/client'
import { loadEnv, loadWebauthnEnv } from './env'
import { ProposalEngine } from './proposals'
import { SealEngine } from './seals'

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass a clock, an object store, a KeyProvider and a Db on a
 * throwaway database, production none (the key comes from the local key file). The Db has no memory adapter by design: tenancy is enforced by Postgres, so
 * contract tests run against real Postgres.
 */
export async function compose(
  overrides: Partial<AppDeps> = {}
): Promise<{ app: Hono; adapters: AppDeps }> {
  const { db, devGuildHeader, objectStore, keys, trustProxy, anchor } =
    overrides.db &&
    overrides.devGuildHeader !== undefined &&
    overrides.objectStore &&
    overrides.keys
      ? {
          db: overrides.db,
          devGuildHeader: overrides.devGuildHeader,
          objectStore: overrides.objectStore,
          keys: overrides.keys,
          anchor: overrides.anchor ?? new MemoryCheckpointAnchor(),
          trustProxy: false,
        }
      : await fromEnv(overrides)
  const clock = overrides.clock ?? new SystemClock()
  const rp = loadWebauthnEnv()
  const config = overrides.config ?? new PgConfigStore(db, keys)
  const adapters: AppDeps = {
    ...overrides,
    clock,
    db,
    devGuildHeader,
    objectStore,
    identity:
      overrides.identity ??
      new WebAuthnIdentityProvider(new PgIdentityStore(db, keys), {
        clock,
        keys,
        rpId: rp.WEBAUTHN_RP_ID,
        rpName: 'Guildhall',
        origin: rp.WEBAUTHN_ORIGIN,
      }),
    keys,
    anchor,
    rateLimiter: overrides.rateLimiter ?? new PgRateLimiter(db, clock),
    trustProxy: overrides.trustProxy ?? trustProxy,
    config,
    seals: overrides.seals ?? new SealEngine({ store: new PgSealStore(db, keys, clock), config }),
    proposals:
      overrides.proposals ?? new ProposalEngine({ store: new PgProposalStore(db, keys, clock) }),
    secrets: overrides.secrets ?? new PgSecretStore(db, keys),
    notes: overrides.notes ?? new PgNoteStore(db, keys),
    quests: overrides.quests ?? new PgQuestQueue(db, keys, clock),
    streamTickets: overrides.streamTickets ?? new PgStreamTicketStore(db, clock),
    // No cheap model is wired yet (and no model id lives in engine code): the deterministic
    // classifier stands in until a ModelClassifier is bound to the guild's `cheap` profile.
    classifier: overrides.classifier ?? new MemoryClassifier(),
    routingLog: overrides.routingLog ?? new PgRoutingLog(db),
  }
  return { app: createApp(adapters), adapters }
}

async function fromEnv(
  overrides: Partial<AppDeps>
): Promise<
  Required<
    Pick<AppDeps, 'db' | 'devGuildHeader' | 'objectStore' | 'keys' | 'trustProxy' | 'anchor'>
  >
> {
  const env = loadEnv()
  return {
    keys:
      overrides.keys ??
      (await FileKeyProvider.open(env.KEY_FILE, { create: env.NODE_ENV !== 'production' })),
    anchor: overrides.anchor ?? new FileCheckpointAnchor(env.CHECKPOINT_DIR),
    db: overrides.db ?? createDb(env.APP_DATABASE_URL),
    devGuildHeader: overrides.devGuildHeader ?? env.DEV_GUILD_HEADER,
    trustProxy: overrides.trustProxy ?? env.TRUST_PROXY,
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
