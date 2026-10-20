import { z } from 'zod'

/** Largest page a {@link NoteStore} list or search returns. */
export const MAX_NOTE_PAGE = 100

/** A note is text or a link. */
export type NoteKind = 'text' | 'link'

/** Stored trust: a fact with evidence, or a quarantined assumption. */
export type NoteTrust = 'fact' | 'quarantined'

/** The fields of a Note as written; shared by add (all required) and edit (all optional). */
export const noteFields = z.object({
  title: z.string().trim().min(1).max(200),
  body: z.string().min(1).max(20000),
  claim: z.enum(['fact', 'assumption']),
  evidence: z.string().trim().min(1).max(2000).optional(),
})

/** Changes accepted by {@link NoteStore.edit}: any subset of the note's fields. */
export type NoteChanges = Partial<{
  title: string | undefined
  body: string | undefined
  claim: 'fact' | 'assumption' | undefined
  evidence: string | undefined
}>

/** Input to {@link NoteStore.add}. A link note's body must be an http(s) URL. */
export const newNote = noteFields
  .extend({ kind: z.enum(['text', 'link']) })
  .superRefine((n, ctx) => {
    if (n.kind === 'link' && !z.url({ protocol: /^https?$/ }).safeParse(n.body).success) {
      ctx.addIssue({ code: 'custom', path: ['body'], message: 'a link note needs an http(s) URL' })
    }
  })

/** Input to {@link NoteStore.add}. */
export type NewNote = z.infer<typeof newNote>

/** One NoteVersion: the note's content as of one write. */
export interface NoteVersion {
  version: number
  title: string
  body: string
  trust: NoteTrust
  evidence: string | null
}

/** A Note at its current NoteVersion. */
export interface Note extends NoteVersion {
  id: string
  kind: NoteKind
}

/** A NoteLink seen from its target: the note that links in with `[[title]]`. */
export interface Backlink {
  id: string
  title: string
}

/** A note with every NoteVersion (oldest first) and its backlinks. */
export interface NoteDetail {
  note: Note
  versions: NoteVersion[]
  backlinks: Backlink[]
}

/** Paging for lists and searches; `hall` limits the result to notes filed under that Hall (applied in the store). */
export interface NotePaging {
  after?: string
  limit: number
  hall?: string
}

/** One page of notes in id order; `next` is the cursor for the following page, null at the end. */
export interface NotePage {
  notes: Note[]
  next: string | null
}

/** Why a note write was refused. */
export type NoteErrorCode = 'evidence_required' | 'not_found'

/** Thrown by {@link NoteStore} writes: a fact without evidence, or an unknown note. */
export class NoteError extends Error {
  constructor(readonly code: NoteErrorCode) {
    super(code)
    this.name = 'NoteError'
  }
}

/** The `[[wiki link]]` targets in `text`, as normalised keys (trimmed, lower-cased, de-duplicated). */
export function wikiLinks(text: string): string[] {
  const keys = new Set<string>()
  for (const m of text.matchAll(/\[\[([^[\]]+)\]\]/g)) {
    const key = titleKey(m[1] ?? '')
    if (key) {
      keys.add(key)
    }
  }
  return [...keys]
}

/** The normalised key a note's title is linked by. */
export function titleKey(title: string): string {
  return title.trim().toLowerCase()
}

/** Search terms: lower-cased runs of letters and digits (matches Postgres' `simple` config). */
export function searchTerms(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
}

/**
 * Resolves the version a write produces: a fact needs evidence, an assumption is quarantined.
 * @throws NoteError `evidence_required`
 */
export function nextVersion(
  fields: {
    title: string
    body: string
    claim: 'fact' | 'assumption'
    evidence?: string | undefined
  },
  version: number
): NoteVersion {
  if (fields.claim === 'fact' && !fields.evidence) {
    throw new NoteError('evidence_required')
  }
  return {
    version,
    title: fields.title,
    body: fields.body,
    trust: fields.claim === 'fact' ? 'fact' : 'quarantined',
    evidence: fields.evidence ?? null,
  }
}

/** Merges `changes` over a note's current version into full fields for {@link nextVersion}. */
export function mergeChanges(current: NoteVersion, changes: NoteChanges) {
  const evidence = changes.evidence ?? current.evidence ?? undefined
  return {
    title: changes.title ?? current.title,
    body: changes.body ?? current.body,
    claim:
      changes.claim ?? (current.trust === 'fact' ? ('fact' as const) : ('assumption' as const)),
    ...(evidence ? { evidence } : {}),
  }
}

/**
 * Port for the Archive. Every write keeps a NoteVersion and appends an event; search is full-text
 * over each note's current version, scoped to one guild.
 */
export interface NoteStore {
  /** Adds a note (version 1), filed under `hallId` when given (otherwise no Hall: the Guild Master's own). A fact without evidence throws {@link NoteError} `evidence_required`. With an `idempotencyKey`, a key already used in this guild returns that note and writes nothing (a retried caller never duplicates it). */
  add(guildId: string, input: NewNote, hallId?: string, idempotencyKey?: string): Promise<Note>
  /** Writes a new NoteVersion with the given fields changed; throws {@link NoteError}. */
  edit(guildId: string, id: string, changes: NoteChanges): Promise<Note>
  /** The note, all its versions and its backlinks; null when absent for this guild or, with `hall`, filed under another Hall (or none). */
  get(guildId: string, id: string, hall?: string): Promise<NoteDetail | null>
  /** Notes in id order, strictly after `after`, at most `limit`. */
  list(guildId: string, page: NotePaging): Promise<NotePage>
  /** Notes whose current version contains every term of `query`, paginated like {@link list}. */
  search(guildId: string, query: string, page: NotePaging): Promise<NotePage>
}
