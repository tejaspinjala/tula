import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { GuildConfig } from '../guild-config'
import type { CharterImporter } from '../ports/charter-import'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import { MAX_RITE_PAGE } from '../ports/rite-store'
import { classifyRiteChange } from '../rites/classify'
import type { RiteEngine } from '../rites/engine'
import {
  applyCharter,
  CHARTER_MAX_BYTES,
  type ExportRite,
  exportCharter,
  parseCharter,
} from './charter'

/** What a `charter.exported` event records: counts only, never the document. */
export type CharterExportedFact = { rites: number; omitted: number }

/** Room the request envelope (`baseVersion`, `importId`) gets beyond the Charter's own byte cap. */
const ENVELOPE_SLACK_BYTES = 4096

const importBody = z.object({
  charter: z.unknown(),
  baseVersion: z.number().int().min(0),
  importId: z.string().min(1).max(200),
})

/** What the Charter routes need from the app. */
export interface CharterRouteDeps {
  rites: RiteEngine
  config: ConfigStore
  clock: Clock
  /** Writes an import (config proposal, Rite drafts, event, idempotency record) all or nothing. */
  imports: CharterImporter
  /** Whether `config` names a subscription provider this host has not enabled. */
  namesDisabledSubscription: (config: GuildConfig) => boolean
  /** The guild's name, or null when it is unknown. */
  guildName: (guildId: string) => Promise<string | null>
  /** Writes the `charter.exported` event to the guild's ledger. */
  recordExported: (guildId: string, fact: CharterExportedFact) => Promise<void>
  /** Largest document the route returns; defaults to `CHARTER_MAX_BYTES`. */
  maxBytes?: number
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
    if (
      new TextEncoder().encode(JSON.stringify(charter)).length >
      (deps.maxBytes ?? CHARTER_MAX_BYTES)
    ) {
      return c.json({ error: 'charter_too_large' }, 413)
    }
    await deps.recordExported(who.guild, {
      rites: charter.rites.length,
      omitted: charter.omitted.length,
    })
    return c.json(charter)
  })
  app.post('/guilds/:id/charter/import', async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const cap = deps.maxBytes ?? CHARTER_MAX_BYTES
    const declared = Number(c.req.header('content-length') ?? 0)
    if (declared > cap + ENVELOPE_SLACK_BYTES) {
      return c.json({ error: 'charter_too_large' }, 413)
    }
    // The raw size is checked before any JSON parsing.
    const raw = await c.req.text()
    if (new TextEncoder().encode(raw).length > cap + ENVELOPE_SLACK_BYTES) {
      return c.json({ error: 'charter_too_large' }, 413)
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const body = importBody.safeParse(json)
    if (!body.success) {
      return c.json({ error: 'invalid_request' }, 400)
    }
    const text = JSON.stringify(body.data.charter)
    if (new TextEncoder().encode(text).length > cap) {
      return c.json({ error: 'charter_too_large' }, 413)
    }
    const parsed = parseCharter(text)
    if (!parsed.ok) {
      return c.json({ error: 'invalid_charter' }, 422)
    }
    const { config: current } = await deps.config.current(who.guild)
    const applied = applyCharter({
      charter: parsed.charter,
      current,
      existingRiteNames: (await collectRites(who.guild)).map((r) => r.name),
    })
    if (!applied.ok) {
      return c.json({ error: 'invalid_charter' }, 422)
    }
    if (deps.namesDisabledSubscription(applied.config)) {
      return c.json({ error: 'subscription_disabled' }, 409)
    }
    const outcome = await deps.imports.importCharter(who.guild, {
      importId: body.data.importId,
      baseVersion: body.data.baseVersion,
      config: applied.config,
      drafts: applied.drafts.map((d) => ({
        riteId: `r-${crypto.randomUUID()}`,
        name: d.name,
        graph: d.graph,
        classification: classifyRiteChange(null, d.graph),
      })),
    })
    if (!outcome.ok) {
      return c.json({ error: outcome.error }, 409)
    }
    return c.json(outcome.result)
  })
}
