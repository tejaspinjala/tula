import type { Note, NoteStore } from '../ports/note-store'

const SCAN_PAGES = 5
const PAGE = 100

/**
 * The Archive has no Hall column, so a Hall's notes are the ones whose title starts with its
 * prefix. The gateway adds the prefix on every write and filters on it for every read.
 */
export function hallPrefix(hallId: string): string {
  return `[${hallId}] `
}

/** Whether `note` is filed under `hallId`. */
export function inHall(note: Pick<Note, 'title'>, hallId: string): boolean {
  return note.title.startsWith(hallPrefix(hallId))
}

/**
 * The notes of one Hall matching `query` (all of them when empty), at most `limit`, after the cursor.
 * Scans a bounded number of pages; `next` is set when more may follow.
 */
export async function hallNotes(
  notes: NoteStore,
  guildId: string,
  hallId: string,
  options: { query?: string | undefined; after?: string | undefined; limit: number }
): Promise<{ notes: Note[]; next: string | null }> {
  const query = `${hallId} ${options.query ?? ''}`.trim()
  const found: Note[] = []
  let after = options.after
  for (let scanned = 0; scanned < SCAN_PAGES; scanned += 1) {
    const page = await notes.search(guildId, query, {
      ...(after === undefined ? {} : { after }),
      limit: PAGE,
    })
    for (const note of page.notes) {
      if (inHall(note, hallId)) {
        found.push(note)
        if (found.length >= options.limit) {
          return { notes: found, next: note.id }
        }
      }
    }
    if (page.next === null) {
      return { notes: found, next: null }
    }
    after = page.next
  }
  return { notes: found, next: after ?? null }
}

/** One note by id when it is filed under `hallId`, else null (the same answer as for an unknown id). */
export async function hallNote(
  notes: NoteStore,
  guildId: string,
  hallId: string,
  id: string
): Promise<Note | null> {
  const detail = await notes.get(guildId, id)
  return detail && inHall(detail.note, hallId) ? detail.note : null
}
