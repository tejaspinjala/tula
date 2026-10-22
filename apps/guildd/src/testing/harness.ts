import postgres from 'postgres'
import { MemoryCheckpointAnchor } from '../adapters/memory-checkpoint-anchor'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { MemorySandboxRunner } from '../adapters/memory-sandbox-runner'
import { type AppDeps, websocket } from '../app'
import { compose } from '../composition'
import { createDb } from '../db/client'
import { foundTestGuild } from './found-guild'
import { createIsolatedTestDb, testDbUrl } from './test-db'

const NO_LIMIT = { limit: 1_000_000_000, windowMs: 60_000 }
/** Limits so high they never trip; the harness default, for tests that are not about limits. */
export const UNLIMITED_RATE_LIMITS = {
  'signin-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'passkeys-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'passkeys-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  'enrol-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'enrol-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  'desktop-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'desktop-exchange': { client: NO_LIMIT, guild: NO_LIMIT },
  'signin-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  founding: { client: NO_LIMIT },
  'founding-status': { client: NO_LIMIT },
  reauth: { client: NO_LIMIT },
  'stream-ticket': { client: NO_LIMIT, guild: NO_LIMIT },
  'checkpoint-begin': { client: NO_LIMIT, guild: NO_LIMIT },
  'checkpoint-finish': { client: NO_LIMIT, guild: NO_LIMIT },
  'quest-post': { client: NO_LIMIT, guild: NO_LIMIT },
  'rite-read': { client: NO_LIMIT, guild: NO_LIMIT },
  'rite-write': { client: NO_LIMIT, guild: NO_LIMIT },
  'rite-run': { client: NO_LIMIT, guild: NO_LIMIT },
  'archive-export': { client: NO_LIMIT, guild: NO_LIMIT },
  summon: { client: NO_LIMIT, guild: NO_LIMIT },
  'summon-status': { client: NO_LIMIT, guild: NO_LIMIT },
  dispatch: { client: NO_LIMIT, guild: NO_LIMIT },
  'cost-per-post': { client: NO_LIMIT, guild: NO_LIMIT },
  'seal-posted': { client: NO_LIMIT, guild: NO_LIMIT },
  'gateway-call': { client: NO_LIMIT, guild: NO_LIMIT },
  mcp: { client: NO_LIMIT, guild: NO_LIMIT },
  'proposal-post': { client: NO_LIMIT, guild: NO_LIMIT },
  'push-subscribe': { client: NO_LIMIT, guild: NO_LIMIT },
  'learning-scan': { client: NO_LIMIT, guild: NO_LIMIT },
  'events-history': { client: NO_LIMIT, guild: NO_LIMIT },
  'missives-read': { client: NO_LIMIT, guild: NO_LIMIT },
  'dossier-read': { client: NO_LIMIT, guild: NO_LIMIT },
  'dossier-write': { client: NO_LIMIT, guild: NO_LIMIT },
  'bug-report-read': { client: NO_LIMIT, guild: NO_LIMIT },
  'bug-report-write': { client: NO_LIMIT, guild: NO_LIMIT },
  'presence-read': { client: NO_LIMIT, guild: NO_LIMIT },
  'presence-write': { client: NO_LIMIT, guild: NO_LIMIT },
  'session-check': { client: NO_LIMIT },
}

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /**
   * Runs on a database private to the calling test file (dropped by `close`). Required by tests
   * that bar, lift or revoke GLOBALLY: those operations reach every guild of the database.
   */
  isolatedDb?: boolean
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
      | 'missives'
      | 'inquiries'
      | 'seals'
      | 'proposals'
      | 'rites'
      | 'quests'
      | 'mcp'
      | 'tripwires'
      | 'treasury'
      | 'learning'
      | 'githubEnvoy'
      | 'suggestions'
      | 'streamTickets'
      | 'pushStore'
      | 'guildMasterLooks'
      | 'presence'
      | 'councilStore'
      | 'council'
      | 'pushNotifier'
      | 'vapidPublicKey'
      | 'platformOperators'
      | 'pushAllowedHosts'
      | 'gateway'
      | 'sandboxes'
      | 'modelProvider'
      | 'subscriptionProvider'
      | 'objectStore'
      | 'keys'
      | 'anchor'
      | 'objectStoreTimeoutMs'
      | 'maxArtifactBytes'
      | 'eventPollMs'
      | 'rateLimiter'
      | 'rateLimits'
      | 'trustProxy'
      | 'foundingMode'
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
  const isolated = options.isolatedDb ? await createIsolatedTestDb() : null
  const appUrl = testDbUrl('app', isolated?.name)
  const owner = postgres(testDbUrl('owner', isolated?.name), { max: 1, onnotice: () => {} })
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
    // Never let SANDBOX_RUNNER in the environment select Docker under test.
    sandboxes: options.app?.sandboxes ?? new MemorySandboxRunner(),
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
      missives: composed.missives,
      inquiries: composed.inquiries,
      dossiers: composed.dossiers,
      dossierStore: composed.dossierStore,
      bugReports: composed.bugReports,
      bugReportStore: composed.bugReportStore,
      seals: composed.seals,
      proposals: composed.proposals,
      rites: composed.rites,
      charterImports: composed.charterImports,
      quests: composed.quests,
      mcp: composed.mcp,
      tripwires: composed.tripwires,
      treasury: composed.treasury,
      learning: composed.learning,
      streamTickets: composed.streamTickets,
      pushStore: composed.pushStore,
      guildMasterLooks: composed.guildMasterLooks,
      presence: composed.presence,
      councilStore: composed.councilStore,
      council: composed.council,
      pushNotifier: composed.pushNotifier,
      pushRelay: composed.pushRelay,
      gateway: composed.gateway,
      gates: composed.gates,
      sandboxes: composed.sandboxes,
      summon: composed.summon,
      dispatcher: composed.dispatcher,
      sealStore: composed.sealStore,
      modelLedger: composed.modelLedger,
      postCosts: composed.postCosts,
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
      // A global bar's announcements run after its response; end them before the pool closes.
      await composed.gates.stop()
      await db.close()
      await owner.end()
      await isolated?.drop()
    },
  }
}
