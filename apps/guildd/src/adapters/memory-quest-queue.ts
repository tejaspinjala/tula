import type { Clock } from '../ports/clock'
import {
  type ClaimOptions,
  claimTransition,
  completeTransition,
  failTransition,
  hasLiveLease,
  MAX_QUEST_PAGE,
  type NewQuest,
  newQuest,
  pickClaimable,
  type Quest,
  QuestError,
  type QuestPage,
  type QuestPaging,
  type QuestQueue,
  renewTransition,
  retryDelayMs,
  submitTransition,
  type Transition,
} from '../ports/quest-queue'

interface GuildQuests {
  byId: Map<string, Quest>
  byKey: Map<string, string>
  seq: number
}

/**
 * Memory {@link QuestQueue}. Every operation does its check and its write synchronously, with no
 * `await` between, so it is as atomic as the Postgres adapter. State lives in the instance.
 */
export class MemoryQuestQueue implements QuestQueue {
  private readonly guilds = new Map<string, GuildQuests>()

  /** `random` returns [0, 1) and jitters retry delays; inject a constant in tests. */
  constructor(
    private readonly clock: Clock,
    private readonly random: () => number = Math.random
  ) {}

  private guild(guildId: string): GuildQuests {
    const existing = this.guilds.get(guildId)
    if (existing) {
      return existing
    }
    const fresh: GuildQuests = { byId: new Map(), byKey: new Map(), seq: 0 }
    this.guilds.set(guildId, fresh)
    return fresh
  }

  private mustFind(guildId: string, id: string): Quest {
    const found = this.guild(guildId).byId.get(id)
    if (!found) {
      throw new QuestError('not_found')
    }
    return found
  }

  private apply(guildId: string, t: Transition): Quest {
    this.guild(guildId).byId.set(t.quest.id, t.quest)
    return t.quest
  }

  async post(guildId: string, input: NewQuest): Promise<{ quest: Quest; created: boolean }> {
    const parsed = newQuest.parse(input)
    const g = this.guild(guildId)
    const existingId = g.byKey.get(parsed.jobKey)
    const existing = existingId === undefined ? undefined : g.byId.get(existingId)
    if (existing) {
      return { quest: existing, created: false }
    }
    g.seq += 1
    const now = this.clock.now().toISOString()
    const quest: Quest = {
      id: crypto.randomUUID(),
      seq: g.seq,
      jobKey: parsed.jobKey,
      campaignId: parsed.campaignId ?? null,
      templateId: parsed.templateId,
      hallId: parsed.hallId,
      rank: parsed.rank,
      dataClass: parsed.dataClass,
      title: parsed.title,
      ownerId: parsed.ownerId,
      doneCondition: parsed.doneCondition,
      state: 'queued',
      round: 0,
      roundLimit: parsed.roundLimit,
      blockedBy: parsed.blockedBy,
      attempts: 0,
      maxAttempts: parsed.maxAttempts,
      leaseExpiresAt: null,
      notBefore: now,
      lastError: null,
      createdAt: now,
    }
    g.byId.set(quest.id, quest)
    g.byKey.set(quest.jobKey, quest.id)
    return { quest, created: true }
  }

  async claim(guildId: string, options: ClaimOptions): Promise<Quest | null> {
    const now = this.clock.now()
    if (options.questId !== undefined) {
      const target = this.mustFind(guildId, options.questId)
      if (hasLiveLease(target, now)) {
        throw new QuestError('already_claimed')
      }
    }
    const picked = pickClaimable([...this.guild(guildId).byId.values()], now, options)
    return picked ? this.apply(guildId, claimTransition(picked, now, options.leaseMs)) : null
  }

  async renew(guildId: string, id: string, attempt: number, leaseMs: number): Promise<Quest> {
    const t = renewTransition(this.mustFind(guildId, id), attempt, this.clock.now(), leaseMs)
    return this.apply(guildId, t)
  }

  async submitForSeal(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.apply(guildId, submitTransition(this.mustFind(guildId, id), attempt))
  }

  async complete(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.apply(guildId, completeTransition(this.mustFind(guildId, id), attempt))
  }

  async fail(guildId: string, id: string, attempt: number, error: string): Promise<Quest> {
    const quest = this.mustFind(guildId, id)
    const delay = retryDelayMs(quest.attempts, this.random())
    return this.apply(guildId, failTransition(quest, attempt, error, this.clock.now(), delay))
  }

  async get(guildId: string, id: string): Promise<Quest | null> {
    return this.guild(guildId).byId.get(id) ?? null
  }

  async list(guildId: string, paging: QuestPaging): Promise<QuestPage> {
    const after = paging.after === undefined ? 0 : Number(paging.after)
    const limit = Math.min(paging.limit, MAX_QUEST_PAGE)
    const rows = [...this.guild(guildId).byId.values()]
      .filter((q) => q.seq > after && (paging.state === undefined || q.state === paging.state))
      .sort((a, b) => a.seq - b.seq)
    const quests = rows.slice(0, limit)
    const last = quests.at(-1)
    return { quests, next: rows.length > limit && last ? String(last.seq) : null }
  }

  async deadLetters(guildId: string, paging: Omit<QuestPaging, 'state'>): Promise<QuestPage> {
    return this.list(guildId, { ...paging, state: 'dead' })
  }
}
