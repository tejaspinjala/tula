/**
 * Counts (default, a dry run) or removes (`--apply`) orphan guilds: guilds older than the grace
 * period with no passkey whose only events are the ones founding itself writes (ticket #197,
 * migration 0084 removes them once on upgrade). Run it as the database owner, which must be able to
 * bypass row level security. Usage: `bun scripts/orphan-guilds.ts [--apply]`
 * (`DATABASE_URL` selects the database).
 */
import postgres from 'postgres'
import { z } from 'zod'

/** Whether the arguments ask to actually remove the orphans (anything else is a dry run). */
export function wantsApply(args: readonly string[]): boolean {
  return args.includes('--apply')
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  try {
    if (wantsApply(process.argv)) {
      const [row] = await sql`select remove_orphan_guilds() as removed`
      console.log(`removed ${z.object({ removed: z.number() }).parse(row).removed} orphan guild(s)`)
    } else {
      const [row] = await sql`select count(*)::int as n from orphan_guild_ids()`
      const n = z.object({ n: z.number() }).parse(row).n
      console.log(`dry run: ${n} orphan guild(s) would be removed (rerun with --apply)`)
    }
  } finally {
    await sql.end()
  }
}
