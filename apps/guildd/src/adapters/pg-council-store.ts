import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import {
  type ApproveResult,
  COUNCIL_VOICES,
  type CouncilSession,
  type CouncilStore,
  type CouncilVote,
  type NewCouncilVote,
  type OpenSessionResult,
} from '../ports/council-store'
import type { KeyProvider } from '../ports/key-provider'

const sessionRow = z.object({
  session_id: z.string(),
  quest_id: z.string(),
  proposal_hash: z.string(),
  day: z.string(),
  status: z.enum(['open', 'escalated', 'approved']),
  reason: z.string().nullable(),
  created_at: z.coerce.date(),
})

const voteRow = z.object({
  session_id: z.string(),
  voice: z.enum(COUNCIL_VOICES),
  vote: z.enum(['approve', 'block', 'abstain']),
  reasons: z.array(z.string()),
  abstain_code: z.enum(['invalid_output', 'failed', 'cap_reached']).nullable(),
  input_tokens: z.coerce.number(),
  output_tokens: z.coerce.number(),
  cost_micros: z.coerce.number().nullable(),
})

function toSession(row: unknown): CouncilSession {
  const r = sessionRow.parse(row)
  return {
    id: r.session_id,
    questId: r.quest_id,
    proposalHash: r.proposal_hash,
    day: r.day,
    status: r.status,
    reason: r.reason,
    createdAt: r.created_at.toISOString(),
  }
}

/**
 * Postgres {@link CouncilStore}: sessions and votes under forced RLS, unique on (guild, Proposal
 * hash) and (session, voice). Openings serialise per guild on a transaction-level advisory lock so
 * the daily cap cannot be overrun; each change appends its chained event (ids and codes only,
 * never the reasons) in the same transaction.
 */
export class PgCouncilStore implements CouncilStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async open(
    guildId: string,
    input: { questId: string; proposalHash: string; day: string; sessionCap: number }
  ): Promise<OpenSessionResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const [existing] = await tx`
        select session_id, quest_id, proposal_hash, day::text as day, status, reason, created_at
        from council_sessions where proposal_hash = ${input.proposalHash}`
      if (existing) {
        return { status: 'existing', session: toSession(existing) }
      }
      const [count] = await tx`
        select count(*)::int as n from council_sessions where day = ${input.day}::date`
      if (Number(count?.n ?? 0) >= input.sessionCap) {
        return { status: 'cap_reached' }
      }
      const [created] = await tx`
        insert into council_sessions (guild_id, quest_id, proposal_hash, day)
        values (${guildId}, ${input.questId}, ${input.proposalHash}, ${input.day}::date)
        returning session_id, quest_id, proposal_hash, day::text as day, status, reason, created_at`
      const session = toSession(created)
      await appendEvent(tx, this.keys, 'council.convened', {
        sessionId: session.id,
        questId: session.questId,
        proposalHash: session.proposalHash,
      })
      return { status: 'created', session }
    })
  }

  async list(
    guildId: string,
    page: { limit: number; after?: string }
  ): Promise<{ sessions: CouncilSession[]; next: string | null }> {
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select session_id, quest_id, proposal_hash, day::text as day, status, reason, created_at
        from council_sessions
        where ${
          page.after === undefined
            ? tx`true`
            : tx`(created_at, session_id) < (
                select created_at, session_id from council_sessions
                where session_id = ${page.after}::uuid)`
        }
        order by created_at desc, session_id desc
        limit ${page.limit + 1}`
      const sessions = rows.slice(0, page.limit).map(toSession)
      const last = sessions[sessions.length - 1]
      return { sessions, next: rows.length > page.limit && last ? last.id : null }
    })
  }

  async recordVote(guildId: string, sessionId: string, vote: NewCouncilVote): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const inserted = await tx`
        insert into council_votes (guild_id, session_id, voice, vote, reasons, abstain_code,
          input_tokens, output_tokens, cost_micros)
        select ${guildId}, s.session_id, ${vote.voice}, ${vote.vote}, ${tx.json(vote.reasons)},
          ${vote.abstainCode}, ${vote.inputTokens}, ${vote.outputTokens}, ${vote.costMicros}
        from council_sessions s where s.session_id = ${sessionId}
        on conflict do nothing
        returning voice`
      if (inserted.length === 0) {
        return false
      }
      await appendEvent(tx, this.keys, 'council.voted', {
        sessionId,
        voice: vote.voice,
        vote: vote.vote,
      })
      return true
    })
  }

  async votes(guildId: string, sessionId: string): Promise<CouncilVote[]> {
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        select session_id, voice, vote, reasons, abstain_code, input_tokens, output_tokens,
          cost_micros
        from council_votes where session_id = ${sessionId}`
      const votes = rows.map((row) => {
        const r = voteRow.parse(row)
        return {
          sessionId: r.session_id,
          voice: r.voice,
          vote: r.vote,
          reasons: r.reasons,
          abstainCode: r.abstain_code,
          inputTokens: r.input_tokens,
          outputTokens: r.output_tokens,
          costMicros: r.cost_micros,
        }
      })
      return votes.sort((a, b) => COUNCIL_VOICES.indexOf(a.voice) - COUNCIL_VOICES.indexOf(b.voice))
    })
  }

  async claim(
    guildId: string,
    sessionId: string,
    owner: string,
    now: Date,
    ttlMs: number
  ): Promise<boolean> {
    const until = new Date(now.getTime() + ttlMs).toISOString()
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        update council_sessions set claimed_until = ${until}::timestamptz, claim_owner = ${owner}
        where session_id = ${sessionId} and status = 'open'
          and (claimed_until is null or claimed_until <= ${now.toISOString()}::timestamptz
               or claim_owner = ${owner})
        returning session_id`
      return rows.length > 0
    })
  }

  async release(guildId: string, sessionId: string, owner: string): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`
        update council_sessions set claimed_until = null, claim_owner = null
        where session_id = ${sessionId} and status = 'open' and claim_owner = ${owner}`
    })
  }

  async recordFailure(guildId: string, sessionId: string): Promise<number> {
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        update council_sessions set failed_attempts = failed_attempts + 1
        where session_id = ${sessionId} and status = 'open'
        returning failed_attempts`
      return Number(rows[0]?.failed_attempts ?? 0)
    })
  }

  async escalate(guildId: string, sessionId: string, reason: string): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const rows = await tx`
        update council_sessions set status = 'escalated', reason = ${reason}, claimed_until = null, claim_owner = null
        where session_id = ${sessionId} and status = 'open'
        returning quest_id, proposal_hash`
      const row = rows[0]
      if (!row) {
        return false
      }
      await appendEvent(tx, this.keys, 'council.escalated', {
        sessionId,
        questId: String(row.quest_id),
        proposalHash: String(row.proposal_hash),
        reason,
      })
      return true
    })
  }

  async approvalsToday(guildId: string, day: string, excludingQuestId: string): Promise<number> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select count(*)::int as n from council_approvals
        where day = ${day}::date and quest_id <> ${excludingQuestId}`
      return Number(row?.n ?? 0)
    })
  }

  async approve(
    guildId: string,
    sessionId: string,
    input: { questId: string; day: string; cap: number }
  ): Promise<ApproveResult> {
    return this.db.withGuild(guildId, async (tx) => {
      await this.lock(tx, guildId)
      const [session] = await tx`
        select status, proposal_hash from council_sessions where session_id = ${sessionId}`
      if (!session || session.status === 'escalated') {
        return 'not_found'
      }
      const [own] = await tx`
        select 1 as one from council_approvals
        where session_id = ${sessionId} and quest_id = ${input.questId}`
      if (own) {
        return 'approved'
      }
      const [taken] = await tx`
        select count(*)::int as n from council_approvals where day = ${input.day}::date`
      if (Number(taken?.n ?? 0) >= input.cap) {
        return 'cap_reached'
      }
      await tx`
        insert into council_approvals (guild_id, session_id, quest_id, day)
        values (${guildId}, ${sessionId}, ${input.questId}, ${input.day}::date)`
      await tx`
        update council_sessions set status = 'approved', claimed_until = null, claim_owner = null
        where session_id = ${sessionId} and status = 'open'`
      await appendEvent(tx, this.keys, 'council.approved', {
        sessionId,
        questId: input.questId,
        proposalHash: String(session.proposal_hash),
      })
      return 'approved'
    })
  }

  async halt(guildId: string, sessionId: string, questId: string): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      const inserted = await tx`
        insert into council_halts (guild_id, session_id, quest_id)
        select ${guildId}, session_id, ${questId} from council_sessions
        where session_id = ${sessionId}
        on conflict do nothing
        returning session_id`
      if (inserted.length === 0) {
        return false
      }
      await appendEvent(tx, this.keys, 'council.halted', { sessionId, questId })
      return true
    })
  }

  async approvalFor(
    guildId: string,
    questId: string,
    proposalHash: string
  ): Promise<string | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const [row] = await tx`
        select a.session_id from council_approvals a
        join council_sessions s on s.guild_id = a.guild_id and s.session_id = a.session_id
        where a.quest_id = ${questId} and s.proposal_hash = ${proposalHash}`
      return row ? String(row.session_id) : null
    })
  }

  private async lock(tx: TenantTx, guildId: string): Promise<void> {
    await tx`select pg_advisory_xact_lock(hashtextextended(${`council:${guildId}`}, 0))`
  }
}
