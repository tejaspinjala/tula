/**
 * Re-keys the stored wiki links of every guild's notes after the `titleKey` change (#191, ticket
 * #222): each current note body is re-parsed and a note whose stored link keys differ has its links
 * rewritten. Counts only by default (a dry run); `--apply` writes. Each guild runs under its own
 * row level security context, and a second run reports 0 changes. Usage:
 * `bun scripts/rekey-note-links.ts [--apply]` (`DATABASE_URL` selects the database).
 *
 * A one-off maintenance-window script: it works one guild at a time, and `NoteStore.rekeyLinks`
 * locks all of that guild's notes in a single transaction, so writes to them wait until it
 * commits. Run it when the guild is quiet. It is idempotent (safe to rerun or resume after a
 * failure) and a dry run unless `--apply` is given.
 */
import postgres from 'postgres'
import { z } from 'zod'
import { MemoryKeyProvider } from '../apps/guildd/src/adapters/memory-key-provider'
import { PgNoteStore } from '../apps/guildd/src/adapters/pg-note-store'
import { createDb } from '../apps/guildd/src/db/client'
import type { NoteStore } from '../apps/guildd/src/ports/note-store'

/** Whether the arguments ask to actually rewrite the links (anything else is a dry run). */
export function wantsApply(args: readonly string[]): boolean {
  return args.includes('--apply')
}

/** Re-keys each guild in turn (writing only when `apply`); returns the changed-note count per guild that had any. */
export async function rekeyGuilds(
  notes: NoteStore,
  guildIds: readonly string[],
  apply: boolean
): Promise<Map<string, number>> {
  const changed = new Map<string, number>()
  for (const guildId of guildIds) {
    const n = await notes.rekeyLinks(guildId, { dryRun: !apply })
    if (n > 0) {
      changed.set(guildId, n)
    }
  }
  return changed
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL ?? 'postgres://guildhall:guildhall@localhost:5432/guildhall'
  const sql = postgres(url, { max: 1, onnotice: () => {} })
  const db = createDb(url, { max: 1 })
  try {
    const rows = await sql`select guild_id from guilds order by guild_id`
    const ids = rows.map((r) => z.object({ guild_id: z.string() }).parse(r).guild_id)
    const apply = wantsApply(process.argv)
    const changed = await rekeyGuilds(new PgNoteStore(db, new MemoryKeyProvider()), ids, apply)
    const total = [...changed.values()].reduce((a, b) => a + b, 0)
    console.log(
      apply
        ? `re-keyed the links of ${total} note(s) in ${changed.size} guild(s)`
        : `dry run: ${total} note(s) in ${changed.size} guild(s) would be re-keyed (rerun with --apply)`
    )
  } finally {
    await db.close()
    await sql.end()
  }
}
