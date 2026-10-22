import { strToU8, zipSync } from 'fflate'
import type { Context, Hono } from 'hono'
import { z } from 'zod'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import { MAX_NOTE_PAGE, type NoteStore } from '../ports/note-store'
import type { SensitiveCheck } from '../sensitive'
import { buildArchiveExport, type ExportNote, sanitiseFileName } from './archive-export'

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
  /** Zips the files by path; defaults to fflate's `zipSync`. Injectable so a test can make it fail. */
  zip?: (files: Record<string, Uint8Array>) => Uint8Array
  /** Overrides {@link ARCHIVE_EXPORT_CAPS}. */
  caps?: { maxNotes: number; maxBytes: number }
  /** The calling session when it is the Guild Master of `:id`, else a ready response (401/403/404). */
  guildMasterSessionFor: (c: Context) => Promise<{ guild: string } | { res: Response }>
}

const query = z.object({ private: z.enum(['true', 'false']).optional() })

const byteLength = (text: string): number => new TextEncoder().encode(text).length

/** The file name for the download: ASCII only, so the header needs no encoding. */
function downloadName(guildName: string): string {
  const ascii = [...guildName]
    .filter((ch) => ch >= ' ' && ch <= '~')
    .join('')
    .trim()
  const safe = ascii === '' ? '' : sanitiseFileName(ascii)
  return `${safe === '' || safe === 'untitled' ? 'guild' : safe}-archive.zip`
}

/** Mounts `GET /guilds/:id/archive/export` (Guild Master only). */
export function mountArchiveExportRoutes(app: Hono, deps: ArchiveExportDeps): void {
  const caps = deps.caps ?? ARCHIVE_EXPORT_CAPS
  const tooLarge = (c: Context) => c.json({ error: 'archive_too_large' }, 413)

  app.get('/guilds/:id/archive/export', async (c) => {
    const who = await deps.guildMasterSessionFor(c)
    if ('res' in who) {
      return who.res
    }
    const parsed = query.safeParse(c.req.query())
    if (!parsed.success) {
      return c.json({ error: 'invalid_query' }, 400)
    }
    const name = await deps.guildName(who.guild)
    if (name === null) {
      return c.json({ error: 'not_found' }, 404)
    }
    const wantPrivate = parsed.data.private === 'true'
    if (wantPrivate) {
      // Every refusal that can be known up front comes before this line: the check spends the
      // one-use proof. The 413s below happen after the spend and cost the Guild Master a re-auth.
      const check = await deps.checkSensitive(c)
      if (!check.ok) {
        return c.json({ error: check.error }, check.status)
      }
      if (check.guildId !== who.guild) {
        return c.json({ error: 'not_found' }, 404)
      }
    }

    // The default export never reads a private note: the builder sees only what the non-private
    // Archive read model shows, so the files cannot depend on private notes (ADR-0015). Private
    // notes are read only when the caller proved a fresh re-authentication.
    const exported: ExportNote[] = []
    let privateIncluded = 0
    let seen = 0
    let bodyBytes = 0
    let after: string | undefined
    do {
      const page = await deps.notes.list(who.guild, {
        limit: MAX_NOTE_PAGE,
        includePrivate: wantPrivate,
        ...(after === undefined ? {} : { after }),
      })
      for (const n of page.notes) {
        seen++
        bodyBytes += byteLength(n.title) + byteLength(n.body) + byteLength(n.evidence ?? '')
        if (n.dataClass === 'private') {
          privateIncluded++
        }
        exported.push(n)
      }
      if (seen > caps.maxNotes || bodyBytes > caps.maxBytes) {
        return tooLarge(c)
      }
      after = page.next ?? undefined
    } while (after !== undefined)

    const privateLeftOut = wantPrivate ? 0 : await deps.notes.countPrivate(who.guild)
    const { config } = await deps.config.current(who.guild)
    const files = buildArchiveExport({
      notes: exported,
      halls: config.halls.map((h) => ({ id: h.id, name: h.name })),
      guildName: name,
      now: deps.clock.now(),
    })
    const encoded = files.map((f) => [f.path, strToU8(f.content)] as const)
    if (encoded.reduce((sum, [, data]) => sum + data.length, 0) > caps.maxBytes) {
      return tooLarge(c)
    }
    const fact: ArchiveExportedFact = {
      exported: exported.length,
      privateIncluded,
      privateLeftOut,
    }
    const zip = (deps.zip ?? zipSync)(Object.fromEntries(encoded))
    await deps.recordExported(who.guild, fact)
    return new Response(zip, {
      headers: {
        'content-type': 'application/zip',
        'content-disposition': `attachment; filename="${downloadName(name)}"`,
        'x-archive-counts': JSON.stringify(fact),
        'cache-control': 'no-store',
      },
    })
  })
}
