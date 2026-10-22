import type { Context, Hono } from 'hono'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import type { RiteEngine } from '../rites/engine'

/** What a `charter.exported` event records: counts only, never the document. */
export type CharterExportedFact = { rites: number; omitted: number }

/** What the Charter routes need from the app. */
export interface CharterRouteDeps {
  rites: RiteEngine
  config: ConfigStore
  clock: Clock
  /** The guild's name, or null when it is unknown. */
  guildName: (guildId: string) => Promise<string | null>
  /** Writes the `charter.exported` event to the guild's ledger. */
  recordExported: (guildId: string, fact: CharterExportedFact) => Promise<void>
  /** The calling session when it is the Guild Master of `:id`, else a ready response (401/403/404). */
  guildMasterSessionFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
}

/** Mounts `GET /guilds/:id/charter` (Guild Master only). */
export function mountCharterRoutes(_app: Hono, _deps: CharterRouteDeps): void {}
