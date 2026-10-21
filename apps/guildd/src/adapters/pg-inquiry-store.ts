import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type {
  AnswerResult,
  AskResult,
  Inquiry,
  InquiryPage,
  InquiryQuery,
  InquiryStore,
  NewAnswer,
  NewInquiry,
} from '../ports/inquiry-store'
import type { KeyProvider } from '../ports/key-provider'
import { hashBytes } from '../ports/object-store'
import { type PgQuestQueue, toQuest } from './pg-quest-queue'

const row = z.object({
  inquiry_id: z.string(),
  seq: z.coerce.number(),
  from_hall: z.string(),
  to_hall: z.string(),
  ask_quest_id: z.string(),
  answer_quest_id: z.string(),
  asker: z.string(),
  question: z.string(),
  status: z.enum(['open', 'answered', 'expired']),
  answer: z.string().nullable(),
  answered_by: z.string().nullable(),
  note_id: z.string().nullable(),
  asked_at: z.coerce.date(),
  expires_at: z.coerce.date(),
  answered_at: z.coerce.date().nullable(),
})

function toInquiry(r: unknown): Inquiry {
  const i = row.parse(r)
  return {
    seq: i.seq,
    id: i.inquiry_id,
    fromHall: i.from_hall,
    toHall: i.to_hall,
    askQuestId: i.ask_quest_id,
    answerQuestId: i.answer_quest_id,
    asker: i.asker,
    question: i.question,
    status: i.status,
    answer: i.answer,
    answeredBy: i.answered_by,
    noteId: i.note_id,
    askedAt: i.asked_at.toISOString(),
    expiresAt: i.expires_at.toISOString(),
    answeredAt: i.answered_at?.toISOString() ?? null,
  }
}

/**
 * Postgres {@link InquiryStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * An ask takes a per-Quest advisory lock (so the cap and the idempotency check hold under
 * concurrent asks) and posts the answer Quest in the same transaction; an answer locks the row.
 * Ask, answer and expiry append `inquiry.asked`, `inquiry.answered` and `inquiry.expired` (ids
 * only, never the question or answer) to the audit chain in the same transaction.
 */
export class PgInquiryStore implements InquiryStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly quests: PgQuestQueue
  ) {}

  async ask(guildId: string, input: NewInquiry): Promise<AskResult> {
    const dedupe = hashBytes(
      new TextEncoder().encode(
        JSON.stringify([input.askQuestId, input.attempt, input.toHall, input.question])
      )
    )
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`inquiry:${guildId}:${input.askQuestId}`}, 0))`
      const [prior] = await tx`
        select * from inquiries where guild_id = ${guildId} and dedupe_key = ${dedupe}`
      if (prior) {
        const inquiry = toInquiry(prior)
        const [quest] = await tx`
          select * from quests where guild_id = ${guildId} and quest_id = ${inquiry.answerQuestId}`
        return { ok: true, inquiry, answerQuest: toQuest(quest), created: false }
      }
      const [count] = await tx`
        select count(*)::int as n from inquiries
        where guild_id = ${guildId} and ask_quest_id = ${input.askQuestId}`
      if (z.object({ n: z.number() }).parse(count).n >= input.maxPerQuest) {
        return { ok: false, error: 'inquiry_cap' }
      }
      const { quest } = await this.quests.postIn(tx, guildId, input.answerQuest)
      const [created] = await tx`
        insert into inquiries (guild_id, inquiry_id, from_hall, to_hall, ask_quest_id,
          answer_quest_id, asker, question, asked_at, expires_at, dedupe_key)
        values (${guildId}, ${input.id}, ${input.fromHall}, ${input.toHall}, ${input.askQuestId},
          ${quest.id}, ${input.asker}, ${input.question}, ${input.at}, ${input.expiresAt}, ${dedupe})
        returning *`
      const inquiry = toInquiry(created)
      await appendEvent(tx, this.keys, 'inquiry.asked', {
        inquiryId: inquiry.id,
        fromHall: inquiry.fromHall,
        toHall: inquiry.toHall,
        askQuestId: inquiry.askQuestId,
        answerQuestId: inquiry.answerQuestId,
      })
      return { ok: true, inquiry, answerQuest: quest, created: true }
    })
  }

  async answer(guildId: string, input: NewAnswer): Promise<AnswerResult> {
    if (!z.uuid().safeParse(input.inquiryId).success) {
      return { ok: false, error: 'not_found' }
    }
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select * from inquiries
        where guild_id = ${guildId} and inquiry_id = ${input.inquiryId} for update`
      if (!found) {
        return { ok: false, error: 'not_found' }
      }
      const current = toInquiry(found)
      if (current.answerQuestId !== input.answerQuestId) {
        return { ok: false, error: 'not_found' }
      }
      if (current.status === 'answered') {
        return { ok: false, error: 'inquiry_answered' }
      }
      if (current.status === 'expired' || new Date(current.expiresAt) <= input.at) {
        return { ok: false, error: 'inquiry_expired' }
      }
      const [updated] = await tx`
        update inquiries
        set status = 'answered', answer = ${input.answer}, answered_by = ${input.by},
          answered_at = ${input.at}
        where guild_id = ${guildId} and inquiry_id = ${input.inquiryId}
        returning *`
      const inquiry = toInquiry(updated)
      await appendEvent(tx, this.keys, 'inquiry.answered', {
        inquiryId: inquiry.id,
        fromHall: inquiry.fromHall,
        toHall: inquiry.toHall,
        askQuestId: inquiry.askQuestId,
        answerQuestId: inquiry.answerQuestId,
        answeredBy: input.by,
      })
      return { ok: true, inquiry }
    })
  }

  async attachNote(guildId: string, inquiryId: string, noteId: string): Promise<void> {
    if (!z.uuid().safeParse(inquiryId).success) {
      return
    }
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update inquiries set note_id = ${noteId}
        where guild_id = ${guildId} and inquiry_id = ${inquiryId}`
    )
  }

  async get(guildId: string, inquiryId: string): Promise<Inquiry | null> {
    if (!z.uuid().safeParse(inquiryId).success) {
      return null
    }
    const [found] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from inquiries where guild_id = ${guildId} and inquiry_id = ${inquiryId}`
    )
    return found ? toInquiry(found) : null
  }

  async list(guildId: string, query: InquiryQuery): Promise<InquiryPage> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from inquiries
        where guild_id = ${guildId} and (from_hall = ${query.hallId} or to_hall = ${query.hallId})
          and (${query.after ?? null}::bigint is null or seq < ${query.after ?? null})
        order by seq desc
        limit ${query.limit + 1}`
    )
    const page = rows.slice(0, query.limit).map(toInquiry)
    const last = page.at(-1)
    return { inquiries: page, next: rows.length > query.limit && last ? last.seq : null }
  }

  async expireOverdue(guildId: string, at: Date): Promise<number> {
    return this.db.withGuild(guildId, async (tx) => {
      const expired = await tx`
        update inquiries set status = 'expired'
        where guild_id = ${guildId} and status = 'open' and expires_at <= ${at}
        returning *`
      for (const r of expired) {
        const inquiry = toInquiry(r)
        await appendEvent(tx, this.keys, 'inquiry.expired', {
          inquiryId: inquiry.id,
          fromHall: inquiry.fromHall,
          toHall: inquiry.toHall,
          askQuestId: inquiry.askQuestId,
          answerQuestId: inquiry.answerQuestId,
        })
      }
      return expired.length
    })
  }
}
