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
import { EXPIRY_SWEEP_BATCH } from '../ports/inquiry-store'
import type { QuestQueue } from '../ports/quest-queue'

interface Stored {
  inquiry: Inquiry
  /** Quest and attempt-scoped identity of the ask, for idempotency. */
  key: string
  expiresAtMs: number
}

/**
 * Memory adapter for {@link InquiryStore}: state in this instance only. Asks run one after another
 * (the answer Quest is posted between the check and the write), so the cap and the idempotency
 * check hold for same-tick callers; the other writes check and write with no await between.
 */
export class MemoryInquiryStore implements InquiryStore {
  private readonly guilds = new Map<string, Stored[]>()
  private readonly readMarkers = new Map<string, Map<string, number>>()
  private nextSeq = 1
  private asks: Promise<unknown> = Promise.resolve()

  constructor(private readonly quests: QuestQueue) {}

  private markersOf(guildId: string): Map<string, number> {
    let markers = this.readMarkers.get(guildId)
    if (!markers) {
      markers = new Map()
      this.readMarkers.set(guildId, markers)
    }
    return markers
  }

  private inquiries(guildId: string): Stored[] {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = []
      this.guilds.set(guildId, all)
    }
    return all
  }

  ask(guildId: string, input: NewInquiry): Promise<AskResult> {
    const run = this.asks.then(() => this.askNow(guildId, input))
    this.asks = run.catch(() => undefined)
    return run
  }

  private async askNow(guildId: string, input: NewInquiry): Promise<AskResult> {
    const all = this.inquiries(guildId)
    const key = JSON.stringify([input.askQuestId, input.attempt, input.toHall, input.question])
    const prior = all.find((s) => s.key === key)
    if (prior) {
      const answerQuest = await this.quests.get(guildId, prior.inquiry.answerQuestId)
      if (answerQuest) {
        return { ok: true, inquiry: prior.inquiry, answerQuest, created: false }
      }
    }
    if (all.filter((s) => s.inquiry.askQuestId === input.askQuestId).length >= input.maxPerQuest) {
      return { ok: false, error: 'inquiry_cap' }
    }
    const { quest } = await this.quests.post(guildId, input.answerQuest)
    const inquiry: Inquiry = {
      seq: this.nextSeq++,
      id: input.id,
      fromHall: input.fromHall,
      toHall: input.toHall,
      askQuestId: input.askQuestId,
      answerQuestId: quest.id,
      asker: input.asker,
      question: input.question,
      status: 'open',
      answer: null,
      answeredBy: null,
      noteId: null,
      askedAt: input.at.toISOString(),
      expiresAt: input.expiresAt.toISOString(),
      answeredAt: null,
    }
    all.push({ inquiry, key, expiresAtMs: input.expiresAt.getTime() })
    return { ok: true, inquiry, answerQuest: quest, created: true }
  }

  async answer(guildId: string, input: NewAnswer): Promise<AnswerResult> {
    const stored = this.inquiries(guildId).find((s) => s.inquiry.id === input.inquiryId)
    if (!stored || stored.inquiry.answerQuestId !== input.answerQuestId) {
      return { ok: false, error: 'not_found' }
    }
    if (stored.inquiry.status === 'answered') {
      return { ok: false, error: 'inquiry_answered' }
    }
    if (stored.inquiry.status === 'expired' || stored.expiresAtMs <= input.at.getTime()) {
      return { ok: false, error: 'inquiry_expired' }
    }
    stored.inquiry = {
      ...stored.inquiry,
      status: 'answered',
      answer: input.answer,
      answeredBy: input.by,
      answeredAt: input.at.toISOString(),
    }
    return { ok: true, inquiry: stored.inquiry }
  }

  async attachNote(guildId: string, inquiryId: string, noteId: string): Promise<void> {
    const stored = this.inquiries(guildId).find((s) => s.inquiry.id === inquiryId)
    if (stored) {
      stored.inquiry = { ...stored.inquiry, noteId }
    }
  }

  async get(guildId: string, inquiryId: string): Promise<Inquiry | null> {
    return this.inquiries(guildId).find((s) => s.inquiry.id === inquiryId)?.inquiry ?? null
  }

  async list(guildId: string, query: InquiryQuery): Promise<InquiryPage> {
    const matching = this.inquiries(guildId)
      .map((s) => s.inquiry)
      .filter(
        (i) =>
          (i.fromHall === query.hallId || i.toHall === query.hallId) &&
          (query.after === undefined || i.seq < query.after)
      )
      .sort((a, b) => b.seq - a.seq)
    const page = matching.slice(0, query.limit)
    const last = page.at(-1)
    return { inquiries: page, next: matching.length > query.limit && last ? last.seq : null }
  }

  async expireOverdue(guildId: string, at: Date): Promise<number> {
    let expired = 0
    for (const stored of this.inquiries(guildId)) {
      if (expired >= EXPIRY_SWEEP_BATCH) {
        break
      }
      if (stored.inquiry.status === 'open' && stored.expiresAtMs <= at.getTime()) {
        stored.inquiry = { ...stored.inquiry, status: 'expired' }
        expired += 1
      }
    }
    return expired
  }

  async markRead(guildId: string, hallId: string, upToSeq: number): Promise<number> {
    const newest = this.inquiries(guildId)
      .filter((s) => s.inquiry.fromHall === hallId || s.inquiry.toHall === hallId)
      .reduce((max, s) => Math.max(max, s.inquiry.seq), 0)
    const markers = this.markersOf(guildId)
    const next = Math.max(markers.get(hallId) ?? 0, Math.min(upToSeq, newest))
    markers.set(hallId, next)
    return next
  }

  async unreadCounts(guildId: string, hallIds: readonly string[]): Promise<Record<string, number>> {
    const markers = this.markersOf(guildId)
    const all = this.inquiries(guildId)
    return Object.fromEntries(
      hallIds.map((hall) => [
        hall,
        all.filter(
          (s) =>
            s.inquiry.status === 'open' &&
            (s.inquiry.fromHall === hall || s.inquiry.toHall === hall) &&
            s.inquiry.seq > (markers.get(hall) ?? 0)
        ).length,
      ])
    )
  }

  async unreadTotal(guildId: string, hallIds: readonly string[]): Promise<number> {
    const markers = this.markersOf(guildId)
    return this.inquiries(guildId).filter((s) => {
      const touched = hallIds.filter((h) => s.inquiry.fromHall === h || s.inquiry.toHall === h)
      return (
        s.inquiry.status === 'open' &&
        touched.length > 0 &&
        touched.every((h) => s.inquiry.seq > (markers.get(h) ?? 0))
      )
    }).length
  }
}
