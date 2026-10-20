import type { Hono } from 'hono'
import { SystemClock } from './adapters/system-clock'
import { type AppDeps, createApp } from './app'
import { createDb } from './db/client'
import { loadEnv } from './env'

/**
 * The single composition root: wires adapters into the app.
 * Overrides swap adapters; tests pass a clock and a Db on a throwaway database, production none.
 * The Db has no memory adapter by design: tenancy is enforced by Postgres, so contract tests
 * run against real Postgres.
 */
export function compose(overrides: Partial<AppDeps> = {}): { app: Hono; adapters: AppDeps } {
  const { db, devGuildHeader } =
    overrides.db && overrides.devGuildHeader !== undefined
      ? { db: overrides.db, devGuildHeader: overrides.devGuildHeader }
      : fromEnv(overrides)
  const adapters: AppDeps = { clock: new SystemClock(), ...overrides, db, devGuildHeader }
  return { app: createApp(adapters), adapters }
}

function fromEnv(overrides: Partial<AppDeps>): Pick<AppDeps, 'db' | 'devGuildHeader'> {
  const env = loadEnv()
  return {
    db: overrides.db ?? createDb(env.APP_DATABASE_URL),
    devGuildHeader: overrides.devGuildHeader ?? env.DEV_GUILD_HEADER,
  }
}
