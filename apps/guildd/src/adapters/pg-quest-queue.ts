import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import {
  assertHeld,
  type BoardRequest,
  type BoardResult,
  boardRefusal,
  type ClaimOptions,
  cascadeDeadTransitions,
  claimTransition,
  completeTransition,
  dataClass,
  expireTransition,
  type FailReason,
  failReason,
  failTransition,
  isExhausted,
  killTransition,
  MAX_QUEST_PAGE,
  type NewQuest,
  newQuest,
  parkTransition,
  type Quest,
  QuestError,
  type QuestLink,
  type QuestPage,
  type QuestPaging,
  type QuestQueue,
  questEventPayload,
  questRank,
  questState,
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
  TEAM_PLAN_TEMPLATE,
  type Transition,
  type WaitMode,
} from '../ports/quest-queue'

const iso = z.date().transform((d) => d.toISOString())

const questRow = z.object({
  quest_id: z.string(),
  seq: z.coerce.number(),
  job_key: z.string(),
  campaign_id: z.string().nullable(),
  board: z.boolean(),
  template_id: z.string(),
  hall_id: z.string(),
  rank: questRank,
  data_class: dataClass,
  title: z.string(),
  owner_id: z.string(),
  done_condition: z.string(),
  state: questState,
  round: z.number(),
  round_limit: z.number(),
  blocked_by: z.array(z.string()),
  wait_on: z.array(z.string()),
  wait_mode: z.enum(['all', 'any']),
  attempts: z.number(),
  max_attempts: z.number(),
  lease_expires_at: iso.nullable(),
  not_before: iso,
  last_error: z.string().nullable(),
  created_at: iso,
})

const linkRow = z.object({
  parent_id: z.string(),
  child_id: z.string(),
  depth: z.number(),
  attempt: z.number(),
  brief_hash: z.string(),
  data_class: dataClass,
  created_at: iso,
})

function toLink(raw: unknown): QuestLink {
  const r = linkRow.parse(raw)
  return {
    parentId: r.parent_id,
    childId: r.child_id,
    depth: r.depth,
    attempt: r.attempt,
    briefHash: r.brief_hash,
    dataClass: r.data_class,
    createdAt: r.created_at,
  }
}

/** Parses a `quests` row (`select *`, extra columns ignored) into a {@link Quest}. */
export function toQuest(raw: unknown): Quest {
  const r = questRow.parse(raw)
  return {
    id: r.quest_id,
    seq: r.seq,
    jobKey: r.job_key,
    campaignId: r.campaign_id,
    board: r.board,
    templateId: r.template_id,
    hallId: r.hall_id,
    rank: r.rank,
    dataClass: r.data_class,
    title: r.title,
    ownerId: r.owner_id,
    doneCondition: r.done_condition,
    state: r.state,
    round: r.round,
    roundLimit: r.round_limit,
    blockedBy: r.blocked_by,
    waitingOn: r.wait_on,
    waitMode: r.wait_mode,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    leaseExpiresAt: r.lease_expires_at,
    notBefore: r.not_before,
    lastError: r.last_error === null ? null : failReason(r.last_error),
    createdAt: r.created_at,
  }
}

/** Thrown inside a transaction to roll it back and rerun it holding the guild lock. */
class NeedsGuildLock extends Error {}

/**
 * Postgres {@link QuestQueue}. Every call runs in `Db.withGuild` (RLS scopes it to one guild) and
 * appends its transition event in the same transaction. Claims and posts take a per-guild advisory
 * transaction lock, so the concurrency cap, Campaign order and de-duplication hold across processes.
 */
export class PgQuestQueue implements QuestQueue {
  /** `random` returns [0, 1) and jitters retry delays; inject a constant in tests. */
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random
  ) {}

  private async lock(tx: TenantTx, guildId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`quests:${guildId}`}, 0))`
  }

  private async emit(tx: TenantTx, t: Transition, attempt: number): Promise<void> {
    if (t.event) {
      await appendEvent(tx, this.keys, t.event, questEventPayload(t, attempt))
    }
  }

  private async save(tx: TenantTx, guildId: string, t: Transition): Promise<Quest> {
    await this.write(tx, guildId, t)
    const settled = new Set<string>()
    if ((t.event === 'quest.dead' || t.event === 'quest.done') && t.quest.campaignId !== null) {
      settled.add(t.quest.campaignId)
    }
    if (t.event === 'quest.dead') {
      const rows = await tx`
        select * from quests
        where guild_id = ${guildId} and state in ('queued', 'active', 'awaiting_seal')
        for update`
      for (const dependent of cascadeDeadTransitions(rows.map(toQuest), t.quest.id)) {
        await this.write(tx, guildId, dependent)
        if (dependent.quest.campaignId !== null) {
          settled.add(dependent.quest.campaignId)
        }
      }
    }
    for (const campaignId of settled) {
      const [open] = await tx`
        select exists (
          select 1 from quests
          where guild_id = ${guildId} and campaign_id = ${campaignId}
            and state in ('queued', 'active', 'awaiting_seal')) as open,
          exists (
          select 1 from quests
          where guild_id = ${guildId} and campaign_id = ${campaignId} and board) as team`
      const state = z.object({ open: z.boolean(), team: z.boolean() }).parse(open)
      if (state.team && !state.open) {
        await appendEvent(tx, this.keys, 'campaign.finished', { campaignId })
      }
    }
    return t.quest
  }

  private async write(tx: TenantTx, guildId: string, t: Transition): Promise<void> {
    const q = t.quest
    await tx`
      update quests set state = ${q.state}, round = ${q.round}, attempts = ${q.attempts},
        lease_expires_at = ${q.leaseExpiresAt === null ? null : new Date(q.leaseExpiresAt)},
        not_before = ${new Date(q.notBefore)}, last_error = ${q.lastError},
        wait_on = ${`{${q.waitingOn.join(',')}}`}::uuid[], wait_mode = ${q.waitMode},
        max_attempts = ${q.maxAttempts}
      where guild_id = ${guildId} and quest_id = ${q.id}`
    await this.emit(tx, t, q.attempts)
  }

  private async load(tx: TenantTx, guildId: string, id: string): Promise<Quest> {
    const rows = z.uuid().safeParse(id).success
      ? await tx`select * from quests where guild_id = ${guildId} and quest_id = ${id} for update`
      : []
    const row = rows[0]
    if (!row) {
      throw new QuestError('not_found')
    }
    return toQuest(row)
  }

  /**
   * Loads, transitions and saves one Quest in one transaction. A step that settles the Quest (done
   * or dead) must hold the per-guild lock, taken before any row lock, so a Campaign's last two
   * settles are ordered and exactly one sees it finish. Other steps (renew, seal hold, release)
   * run unlocked, so heartbeats do not queue behind claims. A step found to settle without the lock
   * rolls back and reruns with it.
   */
  private async mutate(
    guildId: string,
    id: string,
    step: (quest: Quest) => Transition
  ): Promise<Quest> {
    const run = (locked: boolean) =>
      this.db.withGuild(guildId, async (tx) => {
        if (locked) {
          await this.lock(tx, guildId)
        }
        const before = await this.load(tx, guildId, id)
        const t = step(before)
        if (!locked && (t.event === 'quest.done' || t.event === 'quest.dead')) {
          throw new NeedsGuildLock()
        }
        return t.quest === before ? before : this.save(tx, guildId, t)
      })
    try {
      return await run(false)
    } catch (error) {
      if (error instanceof NeedsGuildLock) {
        return run(true)
      }
      throw error
    }
  }

  /** Inserts a Quest unless its job key exists: the row, or undefined for a repeat. The caller holds the guild lock. */
  private async insertQuest(
    tx: TenantTx,
    guildId: string,
    p: ReturnType<typeof newQuest.parse>
  ): Promise<unknown> {
    const now = this.clock.now()
    const [row] = await tx`
        insert into quests (guild_id, job_key, campaign_id, board, template_id, hall_id, rank,
          data_class, title, owner_id, done_condition, state, round_limit, blocked_by, max_attempts,
          not_before, created_at)
        values (${guildId}, ${p.jobKey}, ${p.campaignId ?? null}, ${p.board}, ${p.templateId}, ${p.hallId},
          ${p.rank}, ${p.dataClass}, ${p.title}, ${p.ownerId}, ${p.doneCondition}, 'queued',
          ${p.roundLimit}, ${`{${p.blockedBy.join(',')}}`}::uuid[], ${p.maxAttempts}, ${now}, ${now})
        on conflict (guild_id, job_key) do nothing
        returning *`
    return row
  }

  async post(guildId: string, input: NewQuest): Promise<{ quest: Quest; created: boolean }> {
    const p = newQuest.parse(input)
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      if (p.blockedBy.length > 0) {
        const [found] = await tx`
          select count(*)::int as n from quests
          where guild_id = ${guildId} and quest_id = any (${`{${p.blockedBy.join(',')}}`}::uuid[])`
        if (z.object({ n: z.number() }).parse(found).n !== new Set(p.blockedBy).size) {
          throw new QuestError('unknown_blocker')
        }
      }
      const row = await this.insertQuest(tx, guildId, p)
      if (!row) {
        const [existing] = await tx`
          select * from quests where guild_id = ${guildId} and job_key = ${p.jobKey}`
        return { quest: toQuest(existing), created: false }
      }
      const quest = toQuest(row)
      await this.emit(tx, { quest, event: 'quest.posted' }, 0)
      return { quest, created: true }
    })
  }

  async claim(guildId: string, options: ClaimOptions): Promise<Quest | null> {
    return this.db.withGuild(guildId, async (tx) => {
      // Bar the Gates comes first: a barred guild (or a global bar) starts nothing.
      const [bar] = await tx`
        select exists (select 1 from guild_gates where guild_id = ${guildId})
            or exists (select 1 from global_gate) as barred`
      if (z.object({ barred: z.boolean() }).parse(bar).barred) {
        return null
      }
      await this.lock(tx, guildId)
      const now = this.clock.now()
      if (options.questId !== undefined) {
        const target = await this.load(tx, guildId, options.questId)
        if (target.state === 'active' && new Date(target.leaseExpiresAt ?? 0) > now) {
          throw new QuestError('already_claimed')
        }
      }
      const lapsed = await tx`
        select * from quests
        where guild_id = ${guildId} and state = 'active' and lease_expires_at <= ${now}
          and attempts >= max_attempts order by seq for update`
      for (const raw of lapsed) {
        const quest = toQuest(raw)
        if (isExhausted(quest, now)) {
          await this.save(tx, guildId, expireTransition(quest))
        }
      }
      const [live] = await tx`
        select count(*)::int as n from quests
        where guild_id = ${guildId} and state = 'active' and lease_expires_at > ${now}`
      if (z.object({ n: z.number() }).parse(live).n >= options.maxActive) {
        return null
      }
      const only = options.questId ?? null
      const caps = Object.entries(options.hallCaps ?? {})
      const capHalls = caps.map(([hall]) => hall)
      const capLimits = caps.map(([, limit]) => limit)
      const [row] = await tx`
        select q.* from quests q
        where q.guild_id = ${guildId}
          and (q.state = 'queued' or (q.state = 'active' and q.lease_expires_at <= ${now}))
          and q.not_before <= ${now}
          and not exists (
            select 1 from hall_pauses hp
            where hp.guild_id = q.guild_id and hp.hall_id = q.hall_id)
          and (${only}::uuid is null or q.quest_id = ${only}::uuid)
          and (q.template_id = ${TEAM_PLAN_TEMPLATE} or not exists (
            select 1 from unnest(${capHalls}::text[], ${capLimits}::int[]) as c(hall, cap)
            where c.hall = q.hall_id and c.cap <= (
              select count(*) from quests l
              where l.guild_id = q.guild_id and l.hall_id = q.hall_id
                and l.template_id <> ${TEAM_PLAN_TEMPLATE}
                and l.state = 'active' and l.lease_expires_at > ${now})))
          and (cardinality(q.wait_on) = 0
            or not exists (
              select 1 from quests w
              where w.guild_id = q.guild_id and w.quest_id = any (q.wait_on)
                and w.state not in ('done', 'dead'))
            or (q.wait_mode = 'any' and exists (
              select 1 from quests w
              where w.guild_id = q.guild_id and w.quest_id = any (q.wait_on)
                and w.state = 'done')))
          and (
            select count(*) from quests b
            where b.guild_id = q.guild_id and b.quest_id = any (q.blocked_by) and b.state = 'done'
          ) = cardinality(q.blocked_by)
          and (q.campaign_id is null or q.board or not exists (
            select 1 from quests o
            where o.guild_id = q.guild_id and o.campaign_id = q.campaign_id and o.seq < q.seq
              and o.state in ('queued', 'active', 'awaiting_seal')))
        order by q.seq limit 1 for update`
      if (!row) {
        return null
      }
      return this.save(tx, guildId, claimTransition(toQuest(row), now, options.leaseMs))
    })
  }

  async renew(guildId: string, id: string, attempt: number, leaseMs: number): Promise<Quest> {
    return this.mutate(guildId, id, (q) => renewTransition(q, attempt, this.clock.now(), leaseMs))
  }

  async submitForSeal(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.mutate(guildId, id, (q) => submitTransition(q, attempt))
  }

  async settleSeal(
    guildId: string,
    id: string,
    outcome: SealOutcome,
    opts?: SealSettleOptions
  ): Promise<Quest> {
    return this.mutate(guildId, id, (q) => sealSettleTransition(q, outcome, this.clock.now(), opts))
  }

  async complete(guildId: string, id: string, attempt: number): Promise<Quest> {
    return this.mutate(guildId, id, (q) => completeTransition(q, attempt))
  }

  async fail(guildId: string, id: string, attempt: number, error: string): Promise<Quest> {
    return this.mutate(guildId, id, (q) =>
      failTransition(q, attempt, error, this.clock.now(), retryDelayMs(q.attempts, this.random()))
    )
  }

  async releaseLeases(guildId: string, reason: FailReason): Promise<number> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const rows = await tx`
        update quests set state = 'queued', lease_expires_at = null,
          not_before = ${this.clock.now()}, last_error = ${reason}
        where guild_id = ${guildId} and state = 'active'
        returning quest_id`
      return rows.length
    })
  }

  releaseAllLeases(reason: FailReason): Promise<number> {
    return this.db.releaseAllLeases(reason)
  }

  async releaseClaim(
    guildId: string,
    id: string,
    attempt: number,
    notBefore: Date
  ): Promise<Quest> {
    return this.mutate(guildId, id, (q) => releaseClaimTransition(q, attempt, notBefore))
  }

  async kill(guildId: string, id: string, attempt: number, reason: string): Promise<Quest> {
    return this.mutate(guildId, id, (q) => killTransition(q, attempt, reason))
  }

  async park(
    guildId: string,
    id: string,
    attempt: number,
    waitingOn: readonly string[],
    mode: WaitMode
  ): Promise<Quest> {
    const ids = [...new Set(waitingOn)]
    return this.db.withGuild(guildId, async (tx) => {
      const before = await this.load(tx, guildId, id)
      const [found] = await tx`
        select count(*)::int as n from quests
        where guild_id = ${guildId} and quest_id = any (${`{${ids.join(',')}}`}::uuid[])`
      if (z.object({ n: z.number() }).parse(found).n !== ids.length) {
        throw new QuestError('unknown_blocker')
      }
      const t = parkTransition(before, attempt, ids, mode, this.clock.now())
      return t.quest === before ? before : this.save(tx, guildId, t)
    })
  }

  async spawn(guildId: string, request: SpawnRequest): Promise<SpawnResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const parent = await this.load(tx, guildId, request.parentId)
      assertHeld(parent, request.attempt)
      const [prior] = await tx`
        select * from quest_children
        where guild_id = ${guildId} and parent_id = ${parent.id}
          and attempt = ${request.attempt} and brief_hash = ${request.briefHash}`
      if (prior) {
        const link = toLink(prior)
        const [row] = await tx`
          select * from quests where guild_id = ${guildId} and quest_id = ${link.childId}`
        return { ok: true, quest: toQuest(row), link, created: false }
      }
      const [above] = await tx`
        select depth from quest_children where guild_id = ${guildId} and child_id = ${parent.id}`
      const parentDepth = above ? z.object({ depth: z.number() }).parse(above).depth : 0
      const [count] = await tx`
        select count(*)::int as n from quest_children
        where guild_id = ${guildId} and parent_id = ${parent.id}`
      const refusal = spawnRefusal(parentDepth, z.object({ n: z.number() }).parse(count).n, request)
      if (refusal) {
        return { ok: false, error: refusal }
      }
      const posted = await this.insertQuest(
        tx,
        guildId,
        newQuest.parse({ ...request.child, jobKey: spawnJobKey(request), blockedBy: [] })
      )
      const quest = toQuest(posted)
      const depth = parentDepth + 1
      const [linked] = await tx`
        insert into quest_children (guild_id, parent_id, child_id, depth, attempt, brief_hash,
          data_class, created_at)
        values (${guildId}, ${parent.id}, ${quest.id}, ${depth}, ${request.attempt},
          ${request.briefHash}, ${quest.dataClass}, ${this.clock.now()})
        returning *`
      await this.emit(tx, { quest, event: 'quest.posted' }, 0)
      await appendEvent(tx, this.keys, 'quest.spawned', {
        parentId: parent.id,
        childId: quest.id,
        depth,
      })
      return { ok: true, quest, link: toLink(linked), created: true }
    })
  }

  async postBoard(guildId: string, request: BoardRequest): Promise<BoardResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      assertHeld(await this.load(tx, guildId, request.parentId), request.attempt)
      const [prior] = await tx`
        select * from quests where guild_id = ${guildId} and job_key = ${request.jobKey}`
      if (prior) {
        return { ok: true, quest: toQuest(prior), created: false }
      }
      const [count] = await tx`
        select count(*)::int as n from quests
        where guild_id = ${guildId} and campaign_id = ${request.campaignId} and board`
      const refusal = boardRefusal(z.object({ n: z.number() }).parse(count).n, request.maxQuests)
      if (refusal) {
        return { ok: false, error: refusal }
      }
      const row = await this.insertQuest(
        tx,
        guildId,
        newQuest.parse({
          ...request.quest,
          jobKey: request.jobKey,
          campaignId: request.campaignId,
          board: true,
        })
      )
      const quest = toQuest(row)
      await this.emit(tx, { quest, event: 'quest.posted' }, 0)
      if (z.object({ n: z.number() }).parse(count).n === 0) {
        await appendEvent(tx, this.keys, 'campaign.started', { campaignId: request.campaignId })
      }
      return { ok: true, quest, created: true }
    })
  }

  async children(guildId: string, parentId: string): Promise<QuestLink[]> {
    if (!z.uuid().safeParse(parentId).success) {
      return []
    }
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select l.* from quest_children l
        join quests q on q.guild_id = l.guild_id and q.quest_id = l.child_id
        where l.guild_id = ${guildId} and l.parent_id = ${parentId}
        order by q.seq`
    )
    return rows.map(toLink)
  }

  async linksFor(guildId: string, childIds: readonly string[]): Promise<QuestLink[]> {
    const ids = childIds.filter((id) => z.uuid().safeParse(id).success)
    if (ids.length === 0) {
      return []
    }
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select l.* from quest_children l
        join quests q on q.guild_id = l.guild_id and q.quest_id = l.child_id
        where l.guild_id = ${guildId} and l.child_id = any (${`{${ids.join(',')}}`}::uuid[])
        order by q.seq`
    )
    return rows.map(toLink)
  }

  async linkOf(guildId: string, childId: string): Promise<QuestLink | null> {
    if (!z.uuid().safeParse(childId).success) {
      return null
    }
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`select * from quest_children where guild_id = ${guildId} and child_id = ${childId}`
    )
    return row ? toLink(row) : null
  }

  async findByJobKey(guildId: string, jobKey: string): Promise<Quest | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select * from quests where guild_id = ${guildId} and job_key = ${jobKey}`
      return row ? toQuest(row) : null
    })
  }

  async get(guildId: string, id: string): Promise<Quest | null> {
    if (!z.uuid().safeParse(id).success) {
      return null
    }
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`select * from quests where guild_id = ${guildId} and quest_id = ${id}`
      return row ? toQuest(row) : null
    })
  }

  async list(guildId: string, paging: QuestPaging): Promise<QuestPage> {
    const after = paging.after === undefined ? 0 : Number(paging.after)
    const limit = Math.min(paging.limit, MAX_QUEST_PAGE)
    const state = paging.state ?? null
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from quests
        where guild_id = ${guildId} and seq > ${after} and (${state}::text is null or state = ${state})
        order by seq limit ${limit + 1}`
    )
    const quests = rows.slice(0, limit).map(toQuest)
    const last = quests.at(-1)
    return { quests, next: rows.length > limit && last ? String(last.seq) : null }
  }

  async deadLetters(guildId: string, paging: Omit<QuestPaging, 'state'>): Promise<QuestPage> {
    return this.list(guildId, { ...paging, state: 'dead' })
  }
}
