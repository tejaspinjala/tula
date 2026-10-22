import { z } from 'zod'
import type { Fetcher } from './artifacts'
import { type PasskeyBrowser, PasskeyRequestError, reauthenticate, type Session } from './passkeys'

const noteBody = z.object({
  id: z.string(),
  kind: z.enum(['text', 'link']),
  version: z.number(),
  title: z.string(),
  body: z.string(),
  trust: z.enum(['fact', 'quarantined']),
  evidence: z.string().nullable(),
  dataClass: z.enum(['public', 'internal', 'private']).default('internal'),
})
const pageBody = z.object({ notes: z.array(noteBody), next: z.string().nullable() })
const detailBody = z.object({
  note: noteBody,
  versions: z.array(noteBody.omit({ id: true, kind: true, dataClass: true })),
  backlinks: z.array(z.object({ id: z.string(), title: z.string() })),
})

const countsHeader = z.object({
  exported: z.number(),
  privateIncluded: z.number(),
  privateLeftOut: z.number(),
})

/** A Note as the Archive returns it: a fact with evidence, or a quarantined assumption. */
export type ArchiveNote = z.infer<typeof noteBody>
/** A note with its NoteVersions and backlinks. */
export type ArchiveNoteDetail = z.infer<typeof detailBody>
/** What the Guild Master types when adding a note. */
export interface NoteDraft {
  kind: 'text' | 'link'
  title: string
  body: string
  claim: 'fact' | 'assumption'
  evidence?: string
}

async function call<T>(
  session: Session,
  fetcher: Fetcher,
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown } = {}
): Promise<T> {
  const res = await fetcher(`/api/guilds/${session.guildId}/archive/notes${path}`, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${session.token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  })
  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  return schema.parse(data)
}

/** Adds a note to the Archive; a fact without evidence is refused with `evidence_required`. */
export function addNote(session: Session, draft: NoteDraft, fetcher: Fetcher) {
  return call(session, fetcher, '', noteBody, { method: 'POST', body: draft })
}

/** Lists the first page of notes. */
export function listNotes(session: Session, fetcher: Fetcher, limit = 50) {
  return call(session, fetcher, `?limit=${limit}`, pageBody)
}

/** Full-text searches the guild's notes (first page). */
export function searchNotes(session: Session, query: string, fetcher: Fetcher, limit = 50) {
  return call(session, fetcher, `?limit=${limit}&q=${encodeURIComponent(query)}`, pageBody)
}

/** What an export hands back: the zip, its file name and the server's counts. */
export interface ArchiveExport {
  blob: Blob
  filename: string
  counts: { exported: number; privateIncluded: number; privateLeftOut: number }
}

/** Exports the Archive as a zip; `includePrivate` first runs the passkey re-auth. */
export async function exportArchive(
  session: Session,
  includePrivate: boolean,
  fetcher: Fetcher,
  browser: PasskeyBrowser
): Promise<ArchiveExport> {
  const headers: Record<string, string> = { authorization: `Bearer ${session.token}` }
  if (includePrivate) {
    headers['x-reauth-proof'] = await reauthenticate(session.token, fetcher, browser)
  }
  const res = await fetcher(
    `/api/guilds/${session.guildId}/archive/export${includePrivate ? '?private=true' : ''}`,
    { method: 'GET', headers }
  )
  if (!res.ok) {
    const data: unknown = await res.json().catch(() => null)
    const code = z.object({ error: z.string() }).safeParse(data)
    throw new PasskeyRequestError(res.status, code.success ? code.data.error : 'unknown')
  }
  const counts = countsHeader.parse(JSON.parse(res.headers.get('x-archive-counts') ?? 'null'))
  const named = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')
  return { blob: await res.blob(), filename: named?.[1] ?? 'archive.zip', counts }
}

/** Reads one note with every version and its backlinks. */
export function readNote(session: Session, id: string, fetcher: Fetcher) {
  return call(session, fetcher, `/${id}`, detailBody)
}
