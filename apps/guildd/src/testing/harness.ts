import postgres from 'postgres'
import { MemoryClock } from '../adapters/memory-clock'
import { compose } from '../composition'
import { createDb } from '../db/client'
import { migrate } from '../db/migrate'

/** Options for {@link createHarness}. */
export interface HarnessOptions {
  /** Instant the memory clock starts at. */
  now?: Date
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
  const urlFor = (user?: string) => {
    const url = new URL(ownerUrl)
    url.pathname = `/${dbName}`
    if (user) {
      url.username = user
      url.password = user
    }
    return url.toString()
  }

  const owner = postgres(urlFor(), { max: 1, onnotice: () => {} })
  await migrate(owner)

  const clock = new MemoryClock(options.now ?? new Date('2026-01-01T00:00:00.000Z'))
  const appUrl = urlFor('guildhall_app')
  const db = createDb(appUrl)
  const { app } = compose({ clock, db })
  return {
    /** Connection URL of the non-owner app role on the throwaway database. */
    appUrl,
    adapters: { clock, db },
    /** Owner-side connection for schema inspection and setup; never for exercising the app. */
    owner,
    /** Sends a request to guildd without opening a socket. */
    request: (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init)),
    /** Closes connections and drops the throwaway database. */
    async close() {
      await db.close()
      await owner.end()
      await admin.unsafe(`drop database ${dbName} with (force)`)
      await admin.end()
    },
  }
}
