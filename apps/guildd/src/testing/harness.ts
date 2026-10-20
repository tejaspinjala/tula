import postgres from 'postgres'
import { MemoryClock } from '../adapters/memory-clock'
import { MemoryObjectStore } from '../adapters/memory-object-store'
import { websocket } from '../app'
import { compose } from '../composition'
import { createDb } from '../db/client'
import { migrate, provisionAppRole } from '../db/migrate'

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /** Instant the memory clock starts at. */
  now?: Date
  /** Whether `x-guild-id` identifies the caller; defaults to true in tests. */
  devGuildHeader?: boolean
}

const DEFAULT_URL = 'postgres://guildhall:guildhall@localhost:5432/guildhall'

/**
 * In-process contract harness: creates a fresh, migrated Postgres database, builds guildd from
 * the composition root (app connecting as the non-owner role) and drives its public routes
 * through `app.request`. Requires the compose Postgres (`docker compose up -d`).
 * Call `close()` to drop the database.
 */
export async function createHarness(options: HarnessOptions = {}) {
  const ownerUrl = process.env.DATABASE_URL ?? DEFAULT_URL
  const dbName = `guildhall_test_${crypto.randomUUID().replaceAll('-', '')}`
  const admin = postgres(ownerUrl, { max: 1, onnotice: () => {} })
  try {
    await admin.unsafe(`create database ${dbName}`)
  } catch (cause) {
    await admin.end()
    throw new Error(
      `Contract tests need Postgres at ${new URL(ownerUrl).host}: run \`docker compose up -d\` (set POSTGRES_PORT and DATABASE_URL if 5432 is taken).`,
      { cause }
    )
  }
  const appPassword = crypto.randomUUID()
  const urlFor = (user?: string) => {
    const url = new URL(ownerUrl)
    url.pathname = `/${dbName}`
    if (user) {
      url.username = user
      url.password = appPassword
    }
    return url.toString()
  }

  const owner = postgres(urlFor(), { max: 1, onnotice: () => {} })
  await migrate(owner)
  await provisionAppRole(owner, appPassword)

  const clock = new MemoryClock(options.now ?? new Date('2026-01-01T00:00:00.000Z'))
  const appUrl = urlFor('guildhall_app')
  const db = createDb(appUrl)
  const objectStore = new MemoryObjectStore()
  const { app } = compose({
    clock,
    db,
    objectStore,
    devGuildHeader: options.devGuildHeader ?? true,
    eventPollMs: 25,
  })
  const servers: Array<ReturnType<typeof Bun.serve>> = []
  return {
    /** Connection URL of the non-owner app role on the throwaway database. */
    appUrl,
    adapters: { clock, db, objectStore },
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
    /** Closes connections and drops the throwaway database. */
    async close() {
      for (const server of servers) {
        await server.stop(true)
      }
      await db.close()
      await owner.end()
      await admin.unsafe(`drop database ${dbName} with (force)`)
      await admin.end()
    },
  }
}
