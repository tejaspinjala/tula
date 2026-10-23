import { z } from 'zod'
import type { DataClass } from './quest-queue'

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
  /** How sensitive the note is; `private` for a note filed by a private-class Quest. */
  dataClass: DataClass
  /** The Hall the note is filed under; null for the Guild Master's own. */
  hallId: string | null
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
  /** Include private notes; omitted otherwise (the default), so a reader outside the private Hall never sees them. */
  includePrivate?: boolean
}

/** Read options for {@link NoteStore.get}. */
export interface NoteReadOptions {
  /** Include a private note and private backlinks; refused (null) otherwise. */
  includePrivate?: boolean
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

/** One `[[target#heading|alias]]` occurrence in a text; `start`/`end` are the source offsets of the whole link. */
export interface WikiLink {
  start: number
  end: number
  target: string
  heading: string | null
  alias: string | null
}

function balanced(text: string): boolean {
  let depth = 0
  for (const ch of text) {
    depth += ch === '[' ? 1 : ch === ']' ? -1 : 0
    if (depth < 0) {
      return false
    }
  }
  return depth === 0
}

/** The target of a link body (before any `|alias` and `#heading`). */
function targetOf(inner: string): string {
  const head = inner.split('|')[0] ?? ''
  return head.split('#')[0] ?? ''
}

/**
 * The single wiki-link parser: each `]]` closes the innermost `[[` before it. `|alias` and then
 * `#heading` / `#^block` are split off. Titles may contain brackets: when the `]]` is followed by
 * more `]`, the target extended by them is also tried, preferring a title `known` to the caller,
 * else the bracket-balanced reading. Links with an empty target are skipped.
 */
export function parseWikiLinks(text: string, known?: (key: string) => boolean): WikiLink[] {
  const links: WikiLink[] = []
  let from = 0
  let scan = 0
  for (;;) {
    const found = text.indexOf(']]', scan)
    if (found < 0) {
      break
    }
    scan = found + 1
    // The innermost link: the last `[[` before this `]]`, after the previous link's end.
    const open = text.lastIndexOf('[[', found - 2)
    if (open < from) {
      continue
    }
    let extra = 0
    while (text[found + 2 + extra] === ']') {
      extra++
    }
    let close = found
    const plain = text.slice(open + 2, found)
    if (extra > 0 && !plain.includes('|') && !plain.includes('#')) {
      const candidates: number[] = []
      for (let k = extra; k >= 0; k--) {
        candidates.push(k)
      }
      const inner = (k: number) => text.slice(open + 2, found + k)
      const byKnown = known
        ? candidates.find((k) => known(titleKey(targetOf(inner(k)))))
        : undefined
      const k =
        byKnown ??
        (balanced(inner(0)) ? 0 : candidates.reverse().find((c) => balanced(inner(c)))) ??
        0
      close = found + k
    }
    from = close + 2
    scan = from
    const inner = text.slice(open + 2, close)
    const bar = inner.indexOf('|')
    const alias = bar < 0 ? null : inner.slice(bar + 1)
    const head = bar < 0 ? inner : inner.slice(0, bar)
    const hash = head.indexOf('#')
    const target = hash < 0 ? head : head.slice(0, hash)
    if (!target.trim()) {
      continue
    }
    links.push({
      start: open,
      end: close + 2,
      target,
      heading: hash < 0 ? null : head.slice(hash + 1),
      alias,
    })
  }
  return links
}

/** The `[[wiki link]]` target titles in `text`, as normalised keys (no alias or heading; trimmed, lower-cased, de-duplicated). */
export function wikiLinks(text: string): string[] {
  return [...new Set(parseWikiLinks(text).map((l) => titleKey(l.target)))]
}

/** The normalised key a note's title is linked by: NFKC, default-ignorable characters (zero-width and the like) removed, trimmed, lower-cased. */
export function titleKey(title: string): string {
  return title
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .trim()
    .toLowerCase()
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
  add(
    guildId: string,
    input: NewNote,
    hallId?: string,
    idempotencyKey?: string,
    dataClass?: DataClass
  ): Promise<Note>
  /** Writes a new NoteVersion with the given fields changed; throws {@link NoteError}. */
  edit(guildId: string, id: string, changes: NoteChanges): Promise<Note>
  /** The note, all its versions and its backlinks; null when absent for this guild or, with `hall`, filed under another Hall (or none). */
  get(
    guildId: string,
    id: string,
    hall?: string,
    options?: NoteReadOptions
  ): Promise<NoteDetail | null>
  /** Notes in id order, strictly after `after`, at most `limit`. */
  list(guildId: string, page: NotePaging): Promise<NotePage>
  /** How many private notes the guild holds; a count only, never a title or body. */
  countPrivate(guildId: string): Promise<number>
  /**
   * Re-parses every note's current body with the current {@link titleKey} and rewrites the stored
   * links of any note whose keys differ (#222). Idempotent.
   * With `dryRun` nothing is written; the count says how many notes would change.
   * @returns how many notes had their links rewritten; 0 on a second run.
   */
  rekeyLinks(guildId: string, options?: { dryRun?: boolean }): Promise<number>
  /** Notes whose current version contains every term of `query`, paginated like {@link list}. */
  search(guildId: string, query: string, page: NotePaging): Promise<NotePage>
}
