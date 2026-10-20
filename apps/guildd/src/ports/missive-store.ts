/** Longest text of one Missive, in characters. */
export const MAX_MISSIVE_CHARS = 2000

/** Largest page a {@link MissiveStore} list returns. */
export const MAX_MISSIVE_PAGE = 100

/** Characters of a Missive's text that its `missive.sent` event carries. */
export const MISSIVE_EXCERPT_CHARS = 80

/** The addressee that reaches every Member of the sender's Hall. */
export const WHOLE_HALL = 'hall'

/** One Missive: a short message from one Member to another, or to the whole Hall. Its `text` is untrusted. */
export interface Missive {
  /** Ordering key: later Missives have a larger one; the page cursor. */
  seq: number
  id: string
  hallId: string
  questId: string
  /** The sending Member. */
  from: string
  /** A Member id, or {@link WHOLE_HALL}. */
  to: string
  text: string
  sentAt: string
}

/** What a Member's Quest sends. */
export interface NewMissive {
  hallId: string
  questId: string
  /** The attempt the send was made in; part of the idempotency key. */
  attempt: number
  from: string
  to: string
  text: string
  /** The most Missives the Quest may have sent (all attempts); past it the send is refused. */
  maxPerQuest: number
  /** The instant the send happened. */
  at: Date
}

/** The outcome of a send: the stored Missive (`created: false` for a repeat), or `missive_cap`. */
export type SendResult =
  | { ok: true; missive: Missive; created: boolean }
  | { ok: false; error: 'missive_cap' }

/** What a list selects. */
export interface MissiveQuery {
  hallId: string
  /** Only Missives this Member sent, received, or that went to the whole Hall. */
  member?: string
  /** Only Missives sent strictly after this instant. */
  since?: Date
  /** The cursor from the previous page. */
  after?: number
  limit: number
}

/** One page of Missives, newest first; `next` is the cursor for the following page, null at the end. */
export interface MissivePage {
  missives: Missive[]
  next: number | null
}

/** Stores Missives per guild, with every call scoped to one guild. */
export interface MissiveStore {
  /**
   * Stores a Missive. Idempotent within one attempt: the same sender, addressee and text again in
   * the same Quest attempt returns the first Missive with `created: false`, whatever the cap says now.
   */
  send(guildId: string, input: NewMissive): Promise<SendResult>
  /** One page of a Hall's Missives, newest first. */
  list(guildId: string, query: MissiveQuery): Promise<MissivePage>
}

/** The short text a `missive.sent` event carries in place of the whole message. */
export function missiveExcerpt(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MISSIVE_EXCERPT_CHARS ? `${flat.slice(0, MISSIVE_EXCERPT_CHARS - 1)}…` : flat
}
