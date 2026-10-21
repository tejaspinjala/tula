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
import type { QuestQueue } from '../ports/quest-queue'

/** Memory adapter for {@link InquiryStore}: state in this instance only. */
export class MemoryInquiryStore implements InquiryStore {
  constructor(readonly quests: QuestQueue) {}

  async ask(_guildId: string, _input: NewInquiry): Promise<AskResult> {
    throw new Error('not implemented')
  }
  async answer(_guildId: string, _input: NewAnswer): Promise<AnswerResult> {
    throw new Error('not implemented')
  }
  async attachNote(_guildId: string, _inquiryId: string, _noteId: string): Promise<void> {
    throw new Error('not implemented')
  }
  async get(_guildId: string, _inquiryId: string): Promise<Inquiry | null> {
    throw new Error('not implemented')
  }
  async list(_guildId: string, _query: InquiryQuery): Promise<InquiryPage> {
    throw new Error('not implemented')
  }
  async expireOverdue(_guildId: string, _at: Date): Promise<number> {
    throw new Error('not implemented')
  }
}
