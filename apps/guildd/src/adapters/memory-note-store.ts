import {
  type Backlink,
  mergeChanges,
  type NewNote,
  type Note,
  type NoteChanges,
  type NoteDetail,
  NoteError,
  type NotePage,
  type NotePaging,
  type NoteStore,
  type NoteVersion,
  nextVersion,
  searchTerms,
  titleKey,
  wikiLinks,
} from '../ports/note-store'

interface Stored {
  kind: Note['kind']
  hall: string | null
  versions: NoteVersion[]
}

/** Memory adapter for {@link NoteStore}: state in this instance only; every write is synchronous. */
export class MemoryNoteStore implements NoteStore {
  private readonly guilds = new Map<string, Map<string, Stored>>()
  /** Note ids by guild and idempotency key. */
  private readonly keyed = new Map<string, string>()

  private notes(guildId: string): Map<string, Stored> {
    let notes = this.guilds.get(guildId)
    if (!notes) {
      notes = new Map()
      this.guilds.set(guildId, notes)
    }
    return notes
  }

  async add(
    guildId: string,
    input: NewNote,
    hallId?: string,
    idempotencyKey?: string
  ): Promise<Note> {
    const version = nextVersion(input, 1)
    // No await from here to the writes, so same-tick calls with one key cannot both insert.
    const slot = `${guildId}\u0000${idempotencyKey}`
    const keyed = idempotencyKey === undefined ? undefined : this.keyed.get(slot)
    const stored = keyed === undefined ? undefined : this.notes(guildId).get(keyed)
    const current = stored?.versions.at(-1)
    if (keyed !== undefined && stored && current) {
      return { id: keyed, kind: stored.kind, ...current }
    }
    const id = crypto.randomUUID()
    this.notes(guildId).set(id, { kind: input.kind, hall: hallId ?? null, versions: [version] })
    if (idempotencyKey !== undefined) {
      this.keyed.set(slot, id)
    }
    return { id, kind: input.kind, ...version }
  }

  async edit(guildId: string, id: string, changes: NoteChanges): Promise<Note> {
    const stored = this.notes(guildId).get(id)
    const current = stored?.versions.at(-1)
    if (!stored || !current) {
      throw new NoteError('not_found')
    }
    const version = nextVersion(mergeChanges(current, changes), current.version + 1)
    stored.versions.push(version)
    return { id, kind: stored.kind, ...version }
  }

  async get(guildId: string, id: string, hall?: string): Promise<NoteDetail | null> {
    const stored = this.notes(guildId).get(id)
    const current = stored?.versions.at(-1)
    if (!stored || !current || (hall !== undefined && stored.hall !== hall)) {
      return null
    }
    const backlinks: Backlink[] = []
    for (const [otherId, other] of this.notes(guildId)) {
      const latest = other.versions.at(-1)
      if (
        otherId !== id &&
        (hall === undefined || other.hall === hall) &&
        latest &&
        wikiLinks(latest.body).includes(titleKey(current.title))
      ) {
        backlinks.push({ id: otherId, title: latest.title })
      }
    }
    backlinks.sort((a, b) => a.id.localeCompare(b.id))
    return {
      note: { id, kind: stored.kind, ...current },
      versions: [...stored.versions],
      backlinks,
    }
  }

  async list(guildId: string, page: NotePaging): Promise<NotePage> {
    return this.page(guildId, page, () => true)
  }

  async search(guildId: string, query: string, page: NotePaging): Promise<NotePage> {
    const terms = searchTerms(query)
    if (terms.length === 0) {
      return { notes: [], next: null }
    }
    return this.page(guildId, page, (v) => {
      const words = new Set(searchTerms(`${v.title} ${v.body}`))
      return terms.every((t) => words.has(t))
    })
  }

  private page(guildId: string, page: NotePaging, keep: (v: NoteVersion) => boolean): NotePage {
    const matches: Note[] = []
    for (const [id, stored] of this.notes(guildId)) {
      const current = stored.versions.at(-1)
      if (
        current &&
        id > (page.after ?? '') &&
        (page.hall === undefined || stored.hall === page.hall) &&
        keep(current)
      ) {
        matches.push({ id, kind: stored.kind, ...current })
      }
    }
    matches.sort((a, b) => (a.id < b.id ? -1 : 1))
    const notes = matches.slice(0, page.limit)
    const last = notes.at(-1)
    return { notes, next: matches.length > page.limit && last ? last.id : null }
  }
}
