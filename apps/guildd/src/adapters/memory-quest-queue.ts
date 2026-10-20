import type { Clock } from '../ports/clock'
import {
  assertHeld,
  type ClaimOptions,
  cascadeDeadTransitions,
  claimTransition,
  completeTransition,
  expireTransition,
  type FailReason,
  failTransition,
  hasLiveLease,
  isExhausted,
  killTransition,
  MAX_QUEST_PAGE,
  type NewQuest,
  newQuest,
  parkTransition,
  pickClaimable,
  type Quest,
  QuestError,
  type QuestLink,
  type QuestPage,
  type QuestPaging,
  type QuestQueue,
  releaseClaimTransition,
  renewTransition,
  retryDelayMs,
  type SealOutcome,
  type SealSettleOptions,
  type SpawnRequest,
  type SpawnResult,
  sealSettleTransition,
  spawnJobKey,
  spawnRefusal,
  submitTransition,
  type Transition,
  type WaitMode,
} from '../ports/quest-queue'

interface GuildQuests {
  byId: Map<string, Quest>
  byKey: Map<string, string>
  seq: number
  links: Map<string, QuestLink>
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
    private readonly random: () => number = Math.random,
    /** Receives each transition's event type and ids-only payload, as the Postgres adapter appends them. */
    private readonly onEvent: (guildId: string, type: string, payload: object) => void = () => {},
    /** Whether a Hall is paused by a Tripwire; claims skip its Quests. Synchronous to keep claim atomic. */
    private readonly isHallPaused: (guildId: string, hallId: string) => boolean = () => false,
    /** Whether the guild, or every guild, is barred (Bar the Gates); claims return nothing. Synchronous to keep claim atomic. */
    private readonly isGuildBarred: (guildId: string) => boolean = () => false
  ) {}

  private guild(guildId: string): GuildQuests {
    const existing = this.guilds.get(guildId)
    if (existing) {
      return existing
    }
    const fresh: GuildQuests = { byId: new Map(), byKey: new Map(), seq: 0, links: new Map() }
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
    this.record(guildId, t)
    if (t.event === 'quest.dead') {
      for (const dependent of cascadeDeadTransitions(
        [...this.guild(guildId).byId.values()],
        t.quest.id
      )) {
        this.record(guildId, dependent)
      }
    }
    return t.quest
  }

  private record(guildId: string, t: Transition): void {
    this.guild(guildId).byId.set(t.quest.id, t.quest)
    if (t.event) {
      this.onEvent(guildId, t.event, {
        questId: t.quest.id,
        hallId: t.quest.hallId,
        attempt: t.quest.attempts,
      })
    }
  }

  async post(guildId: string, input: NewQuest): Promise<{ quest: Quest; created: boolean }> {
    return this.postNow(guildId, input)
  }

  /** Synchronous body of {@link post}, so `spawn` can post and link with no `await` between. */
  private postNow(guildId: string, input: NewQuest): { quest: Quest; created: boolean } {
    const parsed = newQuest.parse(input)
    const g = this.guild(guildId)
    const existingId = g.byKey.get(parsed.jobKey)
    const existing = existingId === undefined ? undefined : g.byId.get(existingId)
    if (existing) {
      return { quest: existing, created: false }
    }
    if (parsed.blockedBy.some((id) => !g.byId.has(id))) {
      throw new QuestError('unknown_blocker')
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
      waitingOn: [],
      waitMode: 'all',
      attempts: 0,
      maxAttempts: parsed.maxAttempts,
      leaseExpiresAt: null,
      notBefore: now,
      lastError: null,
      createdAt: now,
    }
    g.byId.set(quest.id, quest)
    g.byKey.set(quest.jobKey, quest.id)
    this.onEvent(guildId, 'quest.posted', { questId: quest.id, hallId: quest.hallId, attempt: 0 })
    return { quest, created: true }
  }

  async claim(guildId: string, options: ClaimOptions): Promise<Quest | null> {
    if (this.isGuildBarred(guildId)) {
      return null
    }
    const now = this.clock.now()
    if (options.questId !== undefined) {
      const target = this.mustFind(guildId, options.questId)
      if (hasLiveLease(target, now)) {
        throw new QuestError('already_claimed')
      }
    }
    for (const q of this.guild(guildId).byId.values()) {
      if (isExhausted(q, now)) {
        this.apply(guildId, expireTransition(q))
      }
    }
    const picked = pickClaimable([...this.guild(guildId).byId.values()], now, options, (hallId) =>
      this.isHallPaused(guildId, hallId)
    )
    return picked ? this.apply(guildId, claimTransition(picked, now, options.leaseMs)) : null
  }

  async renew(guildId: string, id: string, attempt: number, leaseMs: number): Promise<Quest> {
    const t = renewTransition(this.mustFind(guildId, id), attempt, this.clock.now(), leaseMs)
    return this.apply(guildId, t)
  }

  async submitForSeal(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.apply(guildId, submitTransition(this.mustFind(guildId, id), attempt))
  }

  async settleSeal(
    guildId: string,
    id: string,
    outcome: SealOutcome,
    opts?: SealSettleOptions
  ): Promise<Quest> {
    return this.apply(
      guildId,
      sealSettleTransition(this.mustFind(guildId, id), outcome, this.clock.now(), opts)
    )
  }

  async complete(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.apply(guildId, completeTransition(this.mustFind(guildId, id), attempt))
  }

  async fail(guildId: string, id: string, attempt: number, error: string): Promise<Quest> {
    const quest = this.mustFind(guildId, id)
    const delay = retryDelayMs(quest.attempts, this.random())
    return this.apply(guildId, failTransition(quest, attempt, error, this.clock.now(), delay))
  }

  async releaseLeases(guildId: string, reason: FailReason): Promise<number> {
    const now = this.clock.now().toISOString()
    let released = 0
    for (const q of this.guild(guildId).byId.values()) {
      if (q.state === 'active') {
        this.guild(guildId).byId.set(q.id, {
          ...q,
          state: 'queued',
          leaseExpiresAt: null,
          notBefore: now,
          lastError: reason,
        })
        released += 1
      }
    }
    return released
  }

  async releaseAllLeases(reason: FailReason): Promise<number> {
    let released = 0
    for (const guildId of [...this.guilds.keys()]) {
      released += await this.releaseLeases(guildId, reason)
    }
    return released
  }

  async releaseClaim(
    guildId: string,
    id: string,
    attempt: number,
    notBefore: Date
  ): Promise<Quest> {
    return this.apply(
      guildId,
      releaseClaimTransition(this.mustFind(guildId, id), attempt, notBefore)
    )
  }

  async kill(guildId: string, id: string, attempt: number, reason: string): Promise<Quest> {
    return this.apply(guildId, killTransition(this.mustFind(guildId, id), attempt, reason))
  }

  async park(
    guildId: string,
    id: string,
    attempt: number,
    waitingOn: readonly string[],
    mode: WaitMode
  ): Promise<Quest> {
    const quest = this.mustFind(guildId, id)
    if (waitingOn.some((w) => !this.guild(guildId).byId.has(w))) {
      throw new QuestError('unknown_blocker')
    }
    return this.apply(guildId, parkTransition(quest, attempt, waitingOn, mode, this.clock.now()))
  }

  async spawn(guildId: string, request: SpawnRequest): Promise<SpawnResult> {
    const g = this.guild(guildId)
    const parent = this.mustFind(guildId, request.parentId)
    assertHeld(parent, request.attempt)
    const links = [...g.links.values()]
    const existing = links.find(
      (l) =>
        l.parentId === request.parentId &&
        l.attempt === request.attempt &&
        l.briefHash === request.briefHash
    )
    const known = existing && g.byId.get(existing.childId)
    if (existing && known) {
      return { ok: true, quest: known, link: existing, created: false }
    }
    const parentDepth = g.links.get(parent.id)?.depth ?? 0
    const refusal = spawnRefusal(
      parentDepth,
      links.filter((l) => l.parentId === parent.id).length,
      request
    )
    if (refusal) {
      return { ok: false, error: refusal }
    }
    const { quest } = this.postNow(guildId, {
      ...request.child,
      jobKey: spawnJobKey(request),
      blockedBy: [],
    })
    const link: QuestLink = {
      parentId: parent.id,
      childId: quest.id,
      depth: parentDepth + 1,
      attempt: request.attempt,
      briefHash: request.briefHash,
      dataClass: quest.dataClass,
      createdAt: this.clock.now().toISOString(),
    }
    g.links.set(quest.id, link)
    this.onEvent(guildId, 'quest.spawned', {
      parentId: link.parentId,
      childId: link.childId,
      depth: link.depth,
    })
    return { ok: true, quest, link, created: true }
  }

  async children(guildId: string, parentId: string): Promise<QuestLink[]> {
    const g = this.guild(guildId)
    return [...g.links.values()]
      .filter((l) => l.parentId === parentId)
      .sort((a, b) => (g.byId.get(a.childId)?.seq ?? 0) - (g.byId.get(b.childId)?.seq ?? 0))
  }

  async linksFor(_guildId: string, _childIds: readonly string[]): Promise<QuestLink[]> {
    return []
  }

  async linkOf(guildId: string, childId: string): Promise<QuestLink | null> {
    return this.guild(guildId).links.get(childId) ?? null
  }

  async findByJobKey(guildId: string, jobKey: string): Promise<Quest | null> {
    const g = this.guild(guildId)
    const id = g.byKey.get(jobKey)
    return (id === undefined ? undefined : g.byId.get(id)) ?? null
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
