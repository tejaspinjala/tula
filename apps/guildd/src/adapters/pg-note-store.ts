import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { KeyProvider } from '../ports/key-provider'
import {
  mergeChanges,
  type NewNote,
  type Note,
  type NoteChanges,
  type NoteDetail,
  NoteError,
  type NotePage,
  type NoteStore,
  type NoteVersion,
  nextVersion,
  searchTerms,
  titleKey,
  wikiLinks,
} from '../ports/note-store'

const versionRow = z.object({
  version: z.number(),
  title: z.string(),
  body: z.string(),
  trust: z.enum(['fact', 'quarantined']),
  evidence: z.string().nullable(),
})
const noteRow = versionRow.extend({ note_id: z.string(), kind: z.enum(['text', 'link']) })
const backlinkRow = z.object({ note_id: z.string(), title: z.string() })

function toNote(row: z.infer<typeof noteRow>): Note {
  const { note_id, kind, ...version } = row
  return { id: note_id, kind, ...version }
}

/**
 * Postgres {@link NoteStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * Writes append `note.added` / `note.edited` events in the same transaction.
 */
export class PgNoteStore implements NoteStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async add(guildId: string, input: NewNote): Promise<Note> {
    const version = nextVersion(input, 1)
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        insert into notes (guild_id, kind, current_version) values (${guildId}, ${input.kind}, 1)
        returning note_id`
      const id = z.object({ note_id: z.string() }).parse(row).note_id
      await this.writeVersion(tx, guildId, id, version)
      await appendEvent(tx, this.keys, 'note.added', { noteId: id, version: 1, kind: input.kind })
      return { id, kind: input.kind, ...version }
    })
  }

  async edit(guildId: string, id: string, changes: NoteChanges): Promise<Note> {
    return this.db.withGuild(guildId, async (tx) => {
      // The row lock serialises concurrent edits of one note, so versions stay gap-free.
      const [row] = await tx`
        select n.note_id, n.kind, v.version, v.title, v.body, v.trust, v.evidence
        from notes n join note_versions v
          on v.guild_id = n.guild_id and v.note_id = n.note_id and v.version = n.current_version
        where n.guild_id = ${guildId} and n.note_id = ${id} for update of n`
      if (!row) {
        throw new NoteError('not_found')
      }
      const current = noteRow.parse(row)
      const version = nextVersion(mergeChanges(current, changes), current.version + 1)
      await tx`
        update notes set current_version = ${version.version}
        where guild_id = ${guildId} and note_id = ${id}`
      await this.writeVersion(tx, guildId, id, version)
      await appendEvent(tx, this.keys, 'note.edited', {
        noteId: id,
        version: version.version,
        kind: current.kind,
      })
      return { id, kind: current.kind, ...version }
    })
  }

  async get(guildId: string, id: string): Promise<NoteDetail | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select n.note_id, n.kind, v.version, v.title, v.body, v.trust, v.evidence
        from notes n join note_versions v
          on v.guild_id = n.guild_id and v.note_id = n.note_id and v.version = n.current_version
        where n.guild_id = ${guildId} and n.note_id = ${id}`
      if (!row) {
        return null
      }
      const note = toNote(noteRow.parse(row))
      const versions = await tx`
        select version, title, body, trust, evidence from note_versions
        where guild_id = ${guildId} and note_id = ${id} order by version`
      const links = await tx`
        select n.note_id, v.title from note_links l
          join notes n on n.guild_id = l.guild_id and n.note_id = l.note_id
            and n.current_version = l.version
          join note_versions v on v.guild_id = n.guild_id and v.note_id = n.note_id
            and v.version = n.current_version
        where l.guild_id = ${guildId} and l.target_key = ${titleKey(note.title)}
          and n.note_id <> ${id}
        order by n.note_id`
      return {
        note,
        versions: versions.map((r): NoteVersion => versionRow.parse(r)),
        backlinks: links.map((r) => {
          const b = backlinkRow.parse(r)
          return { id: b.note_id, title: b.title }
        }),
      }
    })
  }

  async list(guildId: string, page: { after?: string; limit: number }): Promise<NotePage> {
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) =>
      this.toPage(
        await tx`
          select n.note_id, n.kind, v.version, v.title, v.body, v.trust, v.evidence
          from notes n join note_versions v
            on v.guild_id = n.guild_id and v.note_id = n.note_id and v.version = n.current_version
          where n.guild_id = ${guildId}
            and (${after}::uuid is null or n.note_id > ${after}::uuid)
          order by n.note_id limit ${page.limit + 1}`,
        page.limit
      )
    )
  }

  async search(
    guildId: string,
    query: string,
    page: { after?: string; limit: number }
  ): Promise<NotePage> {
    const terms = searchTerms(query)
    if (terms.length === 0) {
      return { notes: [], next: null }
    }
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) =>
      this.toPage(
        await tx`
          select n.note_id, n.kind, v.version, v.title, v.body, v.trust, v.evidence
          from notes n join note_versions v
            on v.guild_id = n.guild_id and v.note_id = n.note_id and v.version = n.current_version
          where n.guild_id = ${guildId}
            and v.search @@ plainto_tsquery('simple', ${terms.join(' ')})
            and (${after}::uuid is null or n.note_id > ${after}::uuid)
          order by n.note_id limit ${page.limit + 1}`,
        page.limit
      )
    )
  }

  private toPage(rows: readonly object[], limit: number): NotePage {
    const notes = rows.map((r) => toNote(noteRow.parse(r)))
    const items = notes.slice(0, limit)
    const last = items.at(-1)
    return { notes: items, next: notes.length > limit && last ? last.id : null }
  }

  private async writeVersion(tx: TenantTx, guildId: string, id: string, v: NoteVersion) {
    await tx`
      insert into note_versions (guild_id, note_id, version, title, body, trust, evidence)
      values (${guildId}, ${id}, ${v.version}, ${v.title}, ${v.body}, ${v.trust}, ${v.evidence})`
    for (const key of wikiLinks(v.body)) {
      await tx`
        insert into note_links (guild_id, note_id, version, target_key)
        values (${guildId}, ${id}, ${v.version}, ${key})`
    }
  }
}
