/**
 * Drops per-worktree test databases (`<base>_test_<8 hex>`, see apps/guildd/src/testing/test-db.ts)
 * left behind by removed worktrees. The hash is one-way, so every per-worktree database except
 * this worktree's own is dropped; live worktrees recreate theirs on their next `bun test`.
 * Usage: `bun scripts/drop-test-dbs.ts [--dry-run]` (`DATABASE_URL` selects the server).
 */
import postgres from 'postgres'
import { testDbName } from '../apps/guildd/src/testing/test-db'
import { ident } from './backup-restore'

/** Matches the test suffix of a database name (shared `_test` or per-worktree `_test_<8 hex>`). */
const TEST_SUFFIX = /_test(_[0-9a-f]{8})?$/

function isSafe(name: string): boolean {
  try {
    ident(name)
    return true
  } catch {
    return false
  }
}

/**
 * The per-worktree databases among `names` of the same project as `keep` (exactly
 * `<base>_test_<8 hex>`), minus `keep`. Other projects' databases and unsafe names never appear.
 */
export function staleTestDbs(names: readonly string[], keep: string): string[] {
  const base = keep.replace(TEST_SUFFIX, '')
  return names.filter(
    (n) =>
      n !== keep &&
      n.startsWith(`${base}_test_`) &&
      /^_test_[0-9a-f]{8}$/.test(n.slice(base.length)) &&
      isSafe(n)
  )
}

if (import.meta.main) {
  const dryRun = process.argv.includes('--dry-run')
  const url = process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
  const sql = postgres(url, { max: 1 })
  try {
    const rows = await sql<{ datname: string }[]>`select datname from pg_database`
    const stale = staleTestDbs(
      rows.map((r) => r.datname),
      testDbName()
    )
    for (const name of stale) {
      if (!dryRun) {
        await sql.unsafe(`drop database ${ident(name)} with (force)`)
      }
      console.log(`${dryRun ? 'would drop' : 'dropped'} ${name}`)
    }
    if (stale.length === 0) {
      console.log('no stale per-worktree test databases')
    }
  } finally {
    await sql.end()
  }
}
