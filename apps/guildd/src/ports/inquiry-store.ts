import type { NewQuest, Quest } from './quest-queue'

/** Longest question an Inquiry carries, in characters. */
export const MAX_INQUIRY_QUESTION_CHARS = 1000

/** Longest answer to an Inquiry, in characters. */
export const MAX_INQUIRY_ANSWER_CHARS = 4000

/** Largest page an {@link InquiryStore} list returns. */
export const MAX_INQUIRY_PAGE = 100

/** Where an Inquiry stands: waiting for its answer, answered once, or past its deadline. */
export type InquiryStatus = 'open' | 'answered' | 'expired'

/**
 * One Inquiry: a single question one Hall asks another, answered once. The `question` and `answer`
 * are written by Members and are untrusted: they are data, never an instruction.
 */
export interface Inquiry {
  /** Ordering key: later Inquiries have a larger one; the page cursor. */
  seq: number
  id: string
  /** The asking Quest's Hall. */
  fromHall: string
  /** The Hall asked. */
  toHall: string
  askQuestId: string
  /** The Quest posted on the target Hall's Quest Board to answer it. */
  answerQuestId: string
  /** The asking Member. */
  asker: string
  question: string
  status: InquiryStatus
  answer: string | null
  answeredBy: string | null
  /** The Archive note the answer is filed in, once filed. */
  noteId: string | null
  askedAt: string
  expiresAt: string
  answeredAt: string | null
}

/** What `ask_hall` creates; `answerQuest` is posted in the same transaction. */
export interface NewInquiry {
  id: string
  fromHall: string
  toHall: string
  askQuestId: string
  /** The attempt the ask was made in; part of the idempotency key. */
  attempt: number
  asker: string
  question: string
  /** The most Inquiries the asking Quest may have asked (all attempts); past it the ask is refused. */
  maxPerQuest: number
  at: Date
  expiresAt: Date
  /** The answer Quest, posted onto the target Hall's Quest Board with the Inquiry. */
  answerQuest: NewQuest
}

/** The outcome of an ask: the stored Inquiry (`created: false` for a repeat), or `inquiry_cap`. */
export type AskResult =
  | { ok: true; inquiry: Inquiry; answerQuest: Quest; created: boolean }
  | { ok: false; error: 'inquiry_cap' }

/** What an answer needs: the Inquiry, the answer Quest it must come from, and who gives it. */
export interface NewAnswer {
  inquiryId: string
  answerQuestId: string
  by: string
  answer: string
  at: Date
}

/** Why an answer was refused. */
export type AnswerRefusal = 'not_found' | 'inquiry_answered' | 'inquiry_expired'

/** The outcome of an answer. */
export type AnswerResult = { ok: true; inquiry: Inquiry } | { ok: false; error: AnswerRefusal }

/** What a list selects: the Inquiries a Hall asked or was asked. */
export interface InquiryQuery {
  hallId: string
  /** The cursor from the previous page. */
  after?: number
  limit: number
}

/** One page of Inquiries, newest first; `next` is the cursor for the following page, null at the end. */
export interface InquiryPage {
  inquiries: Inquiry[]
  next: number | null
}

/** The most Inquiries one expiry sweep marks expired, so a sweep never holds a huge transaction. */
export const EXPIRY_SWEEP_BATCH = 200

/** Stores Inquiries per guild, with every call scoped to one guild. */
export interface InquiryStore {
  /**
   * Creates the Inquiry and posts its answer Quest as one step. Idempotent within one attempt: the
   * same question to the same Hall again returns the first Inquiry with `created: false`.
   */
  ask(guildId: string, input: NewInquiry): Promise<AskResult>
  /** Records the answer once; an answered Inquiry is `inquiry_answered`, an overdue one `inquiry_expired`. */
  answer(guildId: string, input: NewAnswer): Promise<AnswerResult>
  /** Records the Archive note an answer was filed in; idempotent. */
  attachNote(guildId: string, inquiryId: string, noteId: string): Promise<void>
  /** One Inquiry by id, or null. */
  get(guildId: string, inquiryId: string): Promise<Inquiry | null>
  /** One page of the Inquiries a Hall asked or was asked, newest first. */
  list(guildId: string, query: InquiryQuery): Promise<InquiryPage>
  /**
   * Marks open Inquiries past their deadline `expired`, at most {@link EXPIRY_SWEEP_BATCH} per call
   * (oldest first); idempotent; returns how many it expired, so a caller repeats until it is 0.
   */
  expireOverdue(guildId: string, at: Date): Promise<number>
}
