import { resolve } from 'node:path'
import postgres, { type Sql } from 'postgres'
import { migrate, provisionAppRole } from '../db/migrate'

const DEFAULT_URL = 'postgres://guildhall:guildhall@localhost:5432/guildhall'

/** Advisory lock key serialising creation and migration of the central test database. */
const SETUP_LOCK = 7_340_100
/** Advisory lock key serialising creation and dropping of scratch schemas. */
const SCRATCH_LOCK = 7_340_101

/**
 * Login password of the `guildhall_app` role in tests. The role is cluster-wide, so every test
 * process must agree on one value (a per-harness password would lock other processes out).
 */
export const TEST_APP_PASSWORD = 'guildhall-test-app'

/** Owner URL the tests were pointed at (`DATABASE_URL`, else the compose default). */
function baseUrl(): URL {
  return new URL(process.env.DATABASE_URL ?? DEFAULT_URL)
}

/** Repository root: the identity a worktree's test database is derived from. */
const REPO_ROOT = resolve(import.meta.dir, '../../../..')

/**
 * Test database name for a base `DATABASE_URL` and repo root: the base name plus `_test`, plus
 * `_<8 hex of sha256(root)>` so each worktree migrates its own database. Under `CI=true` or
 * `TEST_DB_ISOLATE=false` the shared `<base>_test` database is used unchanged.
 */
export function isolatedDbName(
  databaseUrl: string,
  root: string,
  env: Record<string, string | undefined>
): string {
  const base = new URL(databaseUrl).pathname.slice(1) || 'guildhall'
  const shared = base.endsWith('_test') ? base : `${base}_test`
  if (env.CI === 'true' || env.TEST_DB_ISOLATE === 'false') {
    return shared
  }
  const hash = new Bun.CryptoHasher('sha256').update(root).digest('hex').slice(0, 8)
  return `${shared}_${hash}`
}

/** Name of this worktree's test database (see `isolatedDbName`). */
export function testDbName(): string {
  return isolatedDbName(baseUrl().toString(), REPO_ROOT, process.env)
}

/**
 * Connection URL of a test database (default: this worktree's), as the owner or (with `app`) the
 * app role.
 */
export function testDbUrl(role: 'owner' | 'app' = 'owner', name: string = testDbName()): string {
  const url = baseUrl()
  url.pathname = `/${name}`
  if (role === 'app') {
    url.username = 'guildhall_app'
    url.password = TEST_APP_PASSWORD
  }
  return url.toString()
}

/**
 * Creates the given (default: this worktree's) test database if missing and migrates it, once per test run (the Bun test
 * preload calls this). A session advisory lock on the server's maintenance database makes
 * parallel runs wait for each other instead of racing on `create database`. This is the only
 * place that ever issues `create database`.
 */
export async function ensureTestDatabase(name: string = testDbName()): Promise<void> {
  const admin = postgres(baseUrl().toString(), { max: 1, onnotice: () => {} })
  try {
    await admin`select pg_advisory_lock(${SETUP_LOCK})`
    try {
      const found = await admin`select 1 from pg_database where datname = ${name}`
      if (found.length === 0) {
        await admin.unsafe(`create database "${name}"`)
      }
      const owner = postgres(testDbUrl('owner', name), { max: 1, onnotice: () => {} })
      try {
        await migrate(owner)
        await provisionAppRole(owner, TEST_APP_PASSWORD)
      } finally {
        await owner.end()
      }
    } finally {
      await admin`select pg_advisory_unlock(${SETUP_LOCK})`
    }
  } catch (cause) {
    throw new Error(
      `Contract tests need Postgres at ${baseUrl().host}: run \`docker compose up -d\` (set POSTGRES_PORT and DATABASE_URL if 5432 is taken).`,
      { cause }
    )
  } finally {
    await admin.end()
  }
}

/**
 * Runs `fn` against an empty, uniquely named schema inside the central test database, then drops
 * it. For tests that need a pristine schema (migration runner, RLS-lint fixtures) without a new
 * database. Create and drop run under an advisory lock.
 */
export async function withScratchSchema<T>(
  fn: (sql: Sql, schema: string) => Promise<T>
): Promise<T> {
  const schema = `scratch_${crypto.randomUUID().replaceAll('-', '')}`
  const sql = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
  const locked = async (statement: string) => {
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${SCRATCH_LOCK})`
      await tx.unsafe(statement)
    })
  }
  await locked(`create schema ${schema}`)
  try {
    return await fn(sql, schema)
  } finally {
    await locked(`drop schema ${schema} cascade`)
    await sql.end()
  }
}

/** A database private to one test file, for tests whose operations reach every guild (global bars). */
export interface IsolatedTestDb {
  /** Database name; pass it to {@link testDbUrl}. */
  name: string
  /** Drops the database; call in `afterAll`, after every connection to it is closed. */
  drop: () => Promise<void>
}

/**
 * Creates and migrates a database named after this worktree's test database and the calling test
 * file (`Bun.main`), so a global Bar the Gates, `release_all_leases` or `revoke_all_run_tokens`
 * there can never touch the guilds of another test file. Any copy left by an interrupted run is
 * dropped first.
 */
export async function createIsolatedTestDb(): Promise<IsolatedTestDb> {
  const hash = new Bun.CryptoHasher('sha256').update(Bun.main).digest('hex').slice(0, 8)
  const name = `${testDbName()}_g${hash}`
  const admin = postgres(baseUrl().toString(), { max: 1, onnotice: () => {} })
  const drop = async () => {
    const dropper = postgres(baseUrl().toString(), { max: 1, onnotice: () => {} })
    try {
      await dropper.unsafe(`drop database if exists "${name}" with (force)`)
    } finally {
      await dropper.end()
    }
  }
  try {
    await drop()
    await ensureTestDatabase(name)
  } finally {
    await admin.end()
  }
  return { name, drop }
}
