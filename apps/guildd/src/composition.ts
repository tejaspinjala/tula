import type { Hono } from 'hono'
import { AnthropicModelProvider } from './adapters/anthropic-model-provider'
import { FileCheckpointAnchor } from './adapters/file-checkpoint-anchor'
import { FileKeyProvider } from './adapters/file-key-provider'
import { MemoryCheckpointAnchor } from './adapters/memory-checkpoint-anchor'
import { MemoryClassifier } from './adapters/memory-classifier'
import { MemoryPushNotifier } from './adapters/memory-push-notifier'
import { PgConfigStore } from './adapters/pg-config-store'
import { PgHandoffStore } from './adapters/pg-handoff-store'
import { PgIdentityStore } from './adapters/pg-identity-store'
import { PgModelLedger } from './adapters/pg-model-ledger'
import { PgNoteStore } from './adapters/pg-note-store'
import { PgProposalStore } from './adapters/pg-proposal-store'
import { PgPushStore } from './adapters/pg-push-store'
import { PgQuestQueue } from './adapters/pg-quest-queue'
import { PgRateLimiter } from './adapters/pg-rate-limiter'
import { PgRoutingLog } from './adapters/pg-routing-log'
import { PgSealStore } from './adapters/pg-seal-store'
import { PgSecretStore } from './adapters/pg-secret-store'
import { PgStreamTicketStore } from './adapters/pg-stream-ticket-store'
import { PgToolsetStore } from './adapters/pg-toolset-store'
import { PgTreasuryStore } from './adapters/pg-treasury-store'
import { PgTripwireStore } from './adapters/pg-tripwire-store'
import { S3ObjectStore } from './adapters/s3-object-store'
import { SystemClock } from './adapters/system-clock'
import { WebPushNotifier } from './adapters/web-push-notifier'
import { WebAuthnIdentityProvider } from './adapters/webauthn-identity-provider'
import { type AppDeps, createApp } from './app'
import { createDb } from './db/client'
import { loadEnv, loadVapidEnv, loadWebauthnEnv } from './env'
import { McpGateway } from './mcp/gateway'
import { ModelGateway } from './model-gateway'

import { ProposalEngine } from './proposals'
import { createSealPushRelay } from './seal-push'
import { SealEngine } from './seals'
import { Treasury } from './treasury'

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
  const secrets = overrides.secrets ?? new PgSecretStore(db, keys)
  const notes = overrides.notes ?? new PgNoteStore(db, keys)
  const quests = overrides.quests ?? new PgQuestQueue(db, keys, clock)
  const tripwires = overrides.tripwires ?? new PgTripwireStore(db, keys, clock)
  const vapid = loadVapidEnv()
  const pushStore = overrides.pushStore ?? new PgPushStore(db)
  // Without VAPID keys (development only; production fails at boot) pushes go to the memory notifier.
  const pushNotifier =
    overrides.pushNotifier ??
    (vapid
      ? new WebPushNotifier({
          publicKey: vapid.publicKey,
          privateKey: vapid.privateKey,
          subject: vapid.subject,
        })
      : new MemoryPushNotifier())
  const identity =
    overrides.identity ??
    new WebAuthnIdentityProvider(new PgIdentityStore(db, keys), {
      clock,
      keys,
      rpId: rp.WEBAUTHN_RP_ID,
      rpName: 'Guildhall',
      origin: rp.WEBAUTHN_ORIGIN,
    })
  const adapters: AppDeps = {
    ...overrides,
    pushStore,
    pushNotifier,
    pushRelay:
      overrides.pushRelay ??
      createSealPushRelay({ db, store: pushStore, notifier: pushNotifier, clock }),
    vapidPublicKey: overrides.vapidPublicKey ?? vapid?.publicKey ?? null,
    clock,
    db,
    devGuildHeader,
    objectStore,
    identity,
    keys,
    anchor,
    rateLimiter: overrides.rateLimiter ?? new PgRateLimiter(db, clock),
    trustProxy: overrides.trustProxy ?? trustProxy,
    config,
    seals:
      overrides.seals ??
      new SealEngine({ store: new PgSealStore(db, keys, clock), config, identity }),
    secrets,
    proposals:
      overrides.proposals ?? new ProposalEngine({ store: new PgProposalStore(db, keys, clock) }),
    notes,
    quests,
    mcp:
      overrides.mcp ??
      new McpGateway({
        quests,
        config,
        notes,
        objectStore,
        handoffs: new PgHandoffStore(db, keys),
        toolsets: new PgToolsetStore(db),
        keys,
        clock,
        tripwires,
      }),
    tripwires,
    treasury:
      overrides.treasury ?? new Treasury({ store: new PgTreasuryStore(db, keys, clock), config }),
    streamTickets: overrides.streamTickets ?? new PgStreamTicketStore(db, clock),
    // No cheap model is wired yet (and no model id lives in engine code): the deterministic
    // classifier stands in until a ModelClassifier is bound to the guild's `cheap` profile.
    classifier: overrides.classifier ?? new MemoryClassifier(),
    routingLog: overrides.routingLog ?? new PgRoutingLog(db),
    gateway:
      overrides.gateway ??
      new ModelGateway({
        ledger: new PgModelLedger(db, keys),
        secrets,
        config,
        provider: overrides.modelProvider ?? new AnthropicModelProvider(),
        clock,
        quests,
        tripwires,
      }),
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
