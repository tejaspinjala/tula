import postgres from 'postgres'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryKeyProvider } from '../adapters/memory-key-provider'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { type AppDeps, websocket } from '../app'
import { compose } from '../composition'
import { createDb } from '../db/client'
import { testDbUrl } from './test-db'

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
      'objectStore' | 'keys' | 'objectStoreTimeoutMs' | 'maxArtifactBytes' | 'eventPollMs'
    >
  >
}

/**
 * In-process contract harness: connects to the central, already-migrated test database (see
 * `test-db.ts`; the Bun preload prepares it once per run), builds guildd from the composition
 * root (app connecting as the non-owner role) and drives its public routes through
 * `app.request`. Tests isolate by founding their own guilds and never assume empty tables.
 * Requires the compose Postgres (`docker compose up -d`).
 */
export async function createHarness(options: HarnessOptions = {}) {
  const appUrl = testDbUrl('app')
  const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  const db = createDb(appUrl)

  const clock = new MemoryClock(options.now ?? new Date('2026-01-01T00:00:00.000Z'))
  const memoryStore = new MemoryObjectStore()
  const objectStore = options.app?.objectStore ?? memoryStore
  const keys = options.app?.keys ?? new MemoryKeyProvider()
  const { app, adapters: composed } = await compose({
    clock,
    db,
    ...options.app,
    objectStore,
    keys,
    devGuildHeader: options.devGuildHeader ?? true,
    eventPollMs: options.app?.eventPollMs ?? 25,
  })
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  return {
    /** Connection URL of the non-owner app role on the central test database. */
    appUrl,
    adapters: { clock, db, objectStore, memoryStore, identity: composed.identity, keys },
    /** Owner-side connection for schema inspection and setup; never for exercising the app. */
    owner,
    /** Sends a request to guildd without opening a socket. */
    request: (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init)),
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
