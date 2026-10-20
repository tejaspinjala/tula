/** Largest page a {@link SuggestionStore.list} call returns. */
export const MAX_SUGGESTION_PAGE = 100

/** A suggestion's decision state: waiting for the Guild Master, or decided for good. */
export type SuggestionStatus = 'pending' | 'accepted' | 'dismissed'

/** A suggested learning as extracted, before it is stored. */
export interface NewSuggestion {
  /** Stable id of what it came from (`pr:owner/name#12`, `adr:owner/name:docs/adr/0001-x.md`). */
  sourceId: string
  repo: string
  kind: 'pr' | 'adr'
  title: string
  body: string
  url: string
}

/** A stored suggested learning. */
export interface Suggestion extends NewSuggestion {
  id: string
  status: SuggestionStatus
  /** The Archive note an accepted suggestion became; null until then. */
  noteId: string | null
  createdAt: string
  decidedAt: string | null
}

/** One page of suggestions in id order; `next` is the cursor for the following page, null at the end. */
export interface SuggestionPage {
  suggestions: Suggestion[]
  next: string | null
}

/** Result of {@link SuggestionStore.decide}. */
export type DecideResult =
  | { ok: true; suggestion: Suggestion }
  | { ok: false; reason: 'not_found' | 'already_decided' }

/**
 * Port for suggested learnings. A suggestion is keyed by its source id within a guild, so one that
 * was ever stored (pending, accepted or dismissed) is never stored or suggested again.
 */
export interface SuggestionStore {
  /** Stores the suggestions whose source id is new to this guild; returns how many were new. */
  addMany(guildId: string, items: readonly NewSuggestion[]): Promise<number>
  /** Suggestions in id order strictly after `after`, optionally only those in `status`. */
  list(
    guildId: string,
    page: { after?: string; limit: number; status?: SuggestionStatus }
  ): Promise<SuggestionPage>
  /** The suggestion, or null when absent for this guild. */
  get(guildId: string, id: string): Promise<Suggestion | null>
  /** Moves a pending suggestion to `accepted` or `dismissed`; the first of two racing decisions wins. */
  decide(guildId: string, id: string, status: 'accepted' | 'dismissed'): Promise<DecideResult>
  /** Records the note an accepted suggestion became. */
  recordNote(guildId: string, id: string, noteId: string): Promise<void>
  /** Returns an accepted suggestion with no note to `pending` (the note could not be written). */
  reopen(guildId: string, id: string): Promise<void>
}
