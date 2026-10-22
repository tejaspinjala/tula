import type { Context, Hono } from 'hono'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import type { NoteStore } from '../ports/note-store'
import type { SensitiveCheck } from '../sensitive'

/** What an `archive.exported` event records: counts only, never a title or a body. */
export type ArchiveExportedFact = {
  exported: number
  privateIncluded: number
  privateLeftOut: number
}

/** Most notes, and most uncompressed bytes, one export carries before it answers 413. */
export const ARCHIVE_EXPORT_CAPS = { maxNotes: 10_000, maxBytes: 50 * 1024 * 1024 } as const

/** What the Archive export route needs from the app. */
export interface ArchiveExportDeps {
  notes: NoteStore
  config: ConfigStore
  clock: Clock
  /** The guild's name, or null when it is unknown. */
  guildName: (guildId: string) => Promise<string | null>
  /** The re-authentication gate for `?private=true` (`checkSensitive` over the request's headers). */
  checkSensitive: (c: Context) => Promise<SensitiveCheck>
  /** Writes the `archive.exported` event to the guild's ledger. */
  recordExported: (guildId: string, fact: ArchiveExportedFact) => Promise<void>
  /** Overrides {@link ARCHIVE_EXPORT_CAPS}. */
  caps?: { maxNotes: number; maxBytes: number }
  /** The calling session when it is the Guild Master of `:id`, else a ready response (401/403/404). */
  guildMasterSessionFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
}

/** Mounts `GET /guilds/:id/archive/export` (Guild Master only). */
export function mountArchiveExportRoutes(app: Hono, _deps: ArchiveExportDeps): void {
  app.get('/guilds/:id/archive/export', (c) => c.json({ error: 'not_implemented' }, 501))
}
