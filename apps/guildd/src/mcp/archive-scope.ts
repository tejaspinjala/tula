import type { Note, NoteStore } from '../ports/note-store'

/**
 * The notes of one Hall matching `query` (all of them when empty), at most `limit`, after the
 * cursor. The Hall filter is applied by the store (a real column), so a title cannot spoof it and
 * notes with no Hall (the Guild Master's own) are never returned.
 */
/** Throws unless `hallId` is a non-empty string: an unscoped read would show every Hall's notes. */
function assertHall(hallId: string): void {
  if (typeof hallId !== 'string' || hallId.length === 0) {
    throw new Error('archive scope needs a Hall')
  }
}

export async function hallNotes(
  notes: NoteStore,
  guildId: string,
  hallId: string,
  options: {
    query?: string | undefined
    after?: string | undefined
    limit: number
    /** The reader is in a private Hall or on a private-class Quest; otherwise private notes are omitted. */
    includePrivate?: boolean
  }
): Promise<{ notes: Note[]; next: string | null }> {
  assertHall(hallId)
  const page = {
    ...(options.after === undefined ? {} : { after: options.after }),
    limit: options.limit,
    hall: hallId,
    includePrivate: options.includePrivate === true,
  }
  const query = options.query?.trim() ?? ''
  const found = query ? await notes.search(guildId, query, page) : await notes.list(guildId, page)
  return { notes: found.notes, next: found.next }
}

/** One note by id when it is filed under `hallId` (and, if private, `includePrivate` is set), else null (the same answer as for an unknown id). */
export async function hallNote(
  notes: NoteStore,
  guildId: string,
  hallId: string,
  id: string,
  includePrivate = false
): Promise<Note | null> {
  assertHall(hallId)
  return (await notes.get(guildId, id, hallId, { includePrivate }))?.note ?? null
}
