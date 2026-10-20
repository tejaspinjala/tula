import postgres from 'postgres'
import { MemoryCheckpointAnchor } from '../adapters/memory-checkpoint-anchor'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { type AppDeps, websocket } from '../app'
import { compose } from '../composition'
import { createDb } from '../db/client'
import { foundTestGuild } from './found-guild'
import { testDbUrl } from './test-db'

const NO_LIMIT = { limit: 1_000_000_000, windowMs: 60_000 }
/** Limits so high they never trip; the harness default, for tests that are not about limits. */
export const UNLIMITED_RATE_LIMITS = {
  'signin-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'passkeys-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'passkeys-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  'signin-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  founding: { client: NO_LIMIT },
  reauth: { client: NO_LIMIT },
  'stream-ticket': { client: NO_LIMIT, guild: NO_LIMIT },
}

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /** Instant the memory clock starts at. */
  now?: Date
  /** Whether `x-guild-id` identifies the caller; defaults to true in tests. */
  devGuildHeader?: boolean
  /** Adapter or limit overrides for the app (db and clock are managed by the harness). */
  app?: Partial<
    Pick<
      AppDeps,
      | 'identity'
      | 'secrets'
      | 'config'
      | 'notes'
      | 'seals'
      | 'quests'
      | 'streamTickets'
      | 'objectStore'
      | 'keys'
      | 'anchor'
      | 'objectStoreTimeoutMs'
      | 'maxArtifactBytes'
      | 'eventPollMs'
      | 'rateLimiter'
      | 'rateLimits'
      | 'trustProxy'
    >
  >
}

/**
 * In-process contract harness: connects to the central, already-migrated test database (see
 * `test-db.ts`; the Bun preload prepares it once per run), builds guildd from the composition
 * root (app connecting as the non-owner role) and drives its public routes through
 * `app.request`. Tests isolate by founding their own guilds and never assume empty tables.
 * Requires the compose Postgres (`docker compose up -d`).
 *
 * Identity and secrets run on the real adapters (WebAuthn identity provider, `PgIdentityStore`,
 * `PgSecretStore`), because founding and vault writes are transactional with the `Db`. The memory
 * adapters are covered by the shared contract suites and can be swapped in through `options.app`.
 */
export async function createHarness(options: HarnessOptions = {}) {
  const appUrl = testDbUrl('app')
  const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  const db = createDb(appUrl)

  const clock = new MemoryClock(options.now ?? new Date('2026-01-01T00:00:00.000Z'))
  const memoryStore = new MemoryObjectStore()
  const objectStore = options.app?.objectStore ?? memoryStore
  const keys = options.app?.keys ?? new MemoryKeyProvider()
  const anchor = options.app?.anchor ?? new MemoryCheckpointAnchor()
  const { app, adapters: composed } = await compose({
    clock,
    db,
    ...options.app,
    objectStore,
    keys,
    anchor,
    devGuildHeader: options.devGuildHeader ?? true,
    eventPollMs: options.app?.eventPollMs ?? 25,
    // Tests found many guilds and sign in from one in-process address, so limits stay off unless a test sets them.
    rateLimits: options.app?.rateLimits ?? UNLIMITED_RATE_LIMITS,
  })
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  return {
    /** Connection URL of the non-owner app role on the central test database. */
    appUrl,
    adapters: {
      clock,
      db,
      objectStore,
      memoryStore,
      identity: composed.identity,
      rateLimiter: composed.rateLimiter,
      secrets: composed.secrets,
      config: composed.config,
      notes: composed.notes,
      seals: composed.seals,
      quests: composed.quests,
      streamTickets: composed.streamTickets,
      classifier: composed.classifier,
      routingLog: composed.routingLog,
      keys,
      anchor,
      witness: { anchor, identity: composed.identity, clock },
    },
    /** Founds a guild through the chained path with the harness's keys (see `foundTestGuild`). */
    foundGuild: (input: { name: string; goal: string }) => foundTestGuild(db, input, keys),
    /** Owner-side connection for schema inspection and setup; never for exercising the app. */
    owner,
    /** Sends a request to guildd without opening a socket. */
    request: (path: string, init?: RequestInit, env?: unknown) =>
      Promise.resolve(app.request(path, init, env)),
    /** Serves guildd on an ephemeral local port (for WebSocket tests); returns its ws base URL. */
    listen() {
      const server = Bun.serve({ port: 0, fetch: app.fetch, websocket })
      servers.push(server)
      return `ws://localhost:${server.port}`
    },
    /** Closes this harness's connections; the shared database stays. */
    async close() {
      for (const server of servers) {
        await server.stop(true)
      }
      await db.close()
      await owner.end()
    },
  }
}
