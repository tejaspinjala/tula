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
  const env = overrides.db && overrides.devGuildHeader !== undefined ? undefined : loadEnv()
  const adapters: AppDeps = {
    clock: new SystemClock(),
    db: overrides.db ?? createDb(String(env?.APP_DATABASE_URL)),
    devGuildHeader: overrides.devGuildHeader ?? env?.DEV_GUILD_HEADER ?? false,
    ...overrides,
  }
  return { app: createApp(adapters), adapters }
}
