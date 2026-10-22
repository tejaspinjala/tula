import type { Context, Hono } from 'hono'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import { MAX_RITE_PAGE } from '../ports/rite-store'
import type { RiteEngine } from '../rites/engine'
import { type ExportRite, exportCharter } from './charter'

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
export function mountCharterRoutes(app: Hono, deps: CharterRouteDeps): void {
  /** Every Rite, live and archived, with the graph of its active version. */
  async function collectRites(guildId: string): Promise<ExportRite[]> {
    const out: ExportRite[] = []
    for (const archived of [false, true]) {
      let after: string | undefined
      do {
        const page = await deps.rites.list(guildId, {
          limit: MAX_RITE_PAGE,
          ...(archived ? { archived } : {}),
          ...(after === undefined ? {} : { after }),
        })
        for (const r of page.rites) {
          const active =
            r.activeVersion === null ? null : await deps.rites.get(guildId, r.id, r.activeVersion)
          out.push({
            id: r.id,
            name: r.name,
            archivedAt: r.archivedAt,
            activeGraph: active?.version.graph ?? null,
          })
        }
        after = page.next ?? undefined
      } while (after !== undefined)
    }
    return out
  }

  app.get('/guilds/:id/charter', async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const name = await deps.guildName(who.guild)
    if (name === null) {
      return c.json({ error: 'not_found' }, 404)
    }
    const { config } = await deps.config.current(who.guild)
    const charter = exportCharter({
      name,
      config,
      rites: await collectRites(who.guild),
      now: deps.clock.now(),
    })
    await deps.recordExported(who.guild, {
      rites: charter.rites.length,
      omitted: charter.omitted.length,
    })
    return c.json(charter)
  })
}
