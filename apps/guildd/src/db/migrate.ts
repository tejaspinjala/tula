import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Sql } from 'postgres'

/** Directory holding the plain SQL migration files. */
export const migrationsDir = join(import.meta.dir, '..', '..', 'migrations')

/** Arbitrary key for the advisory lock that serialises concurrent migrators. */
const LOCK_KEY = 7_340_001

/**
 * Applies every unapplied `*.sql` file in `dir` in filename order, each in its own
 * transaction, recording it in `schema_migrations`. Safe to run repeatedly and concurrently.
 * With `schema`, the migrations (and their bookkeeping) land in that existing schema instead of
 * `public`; used by tests that need a pristine schema inside the shared test database.
 * @returns the names applied by this call (empty when already up to date).
 */
export async function migrate(
  sql: Sql,
  dir: string = migrationsDir,
  options: { schema?: string } = {}
): Promise<{ applied: string[] }> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort()
  const applied: string[] = []

  await sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(${LOCK_KEY})`
    if (options.schema !== undefined) {
      await tx`select set_config('search_path', quote_ident(${options.schema}), true)`
    }
    await tx`create table if not exists schema_migrations (
      name text primary key,
      applied_at timestamptz not null default now()
    )`
    const done = new Set((await tx`select name from schema_migrations`).map((r) => r.name))
    for (const name of files) {
      if (done.has(name)) {
        continue
      }
      await tx.unsafe(await readFile(join(dir, name), 'utf8'))
      await tx`insert into schema_migrations (name) values (${name})`
      applied.push(name)
    }
  })

  return { applied }
}

/**
 * Sets the login password of the non-owner `guildhall_app` role. The password comes from the
 * environment (`APP_DB_PASSWORD`), never from a migration, so no credential lives in the repo.
 */
export async function provisionAppRole(sql: Sql, password: string): Promise<void> {
  const [row] =
    await sql`select format('alter role guildhall_app password %L', ${password}::text) as q`
  await sql.unsafe(String(row?.q))
}
