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

/** Name of the one central test database: the `DATABASE_URL` database name plus `_test`. */
export function testDbName(): string {
  const name = baseUrl().pathname.slice(1) || 'guildhall'
  return name.endsWith('_test') ? name : `${name}_test`
}

/** Connection URL of the central test database, as the owner or (with `app`) the app role. */
export function testDbUrl(role: 'owner' | 'app' = 'owner'): string {
  const url = baseUrl()
  url.pathname = `/${testDbName()}`
  if (role === 'app') {
    url.username = 'guildhall_app'
    url.password = TEST_APP_PASSWORD
  }
  return url.toString()
}

/**
 * Creates the central test database if missing and migrates it, once per test run (the Bun test
 * preload calls this). A session advisory lock on the server's maintenance database makes
 * parallel runs wait for each other instead of racing on `create database`. This is the only
 * place that ever issues `create database`.
 */
export async function ensureTestDatabase(): Promise<void> {
  const admin = postgres(baseUrl().toString(), { max: 1, onnotice: () => {} })
  try {
    await admin`select pg_advisory_lock(${SETUP_LOCK})`
    try {
      const name = testDbName()
      const found = await admin`select 1 from pg_database where datname = ${name}`
      if (found.length === 0) {
        await admin.unsafe(`create database "${name}"`)
      }
      const owner = postgres(testDbUrl(), { max: 1, onnotice: () => {} })
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
