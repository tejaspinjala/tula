import { z } from 'zod'
import type { Db } from '../db/client'
import type {
  NewResearchCall,
  ResearchCall,
  ResearchStore,
  ReserveResult,
} from '../ports/research-store'

const row = z.object({
  call_id: z.string(),
  hall_id: z.string(),
  quest_id: z.string(),
  member_id: z.string(),
})
const tried = z.object({ ok: z.boolean() })
const ids = z.object({ call_id: z.string() })
const counted = z.object({ n: z.number() })

/**
 * Postgres {@link ResearchStore}: every call runs in `Db.withGuild`, so RLS scopes it to one
 * guild. A reservation takes a per-Quest advisory lock, so the cap holds under concurrent calls.
 */
export class PgResearchStore implements ResearchStore {
  constructor(private readonly db: Db) {}

  async reserve(guildId: string, input: NewResearchCall): Promise<ReserveResult> {
    return this.db.withGuild(guildId, async (tx): Promise<ReserveResult> => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`research:${guildId}:${input.questId}`}, 0))`
      const [held] = await tx`
        select count(*)::int as n from research_calls
        where guild_id = ${guildId} and quest_id = ${input.questId} and released_at is null`
      if (counted.parse(held).n >= input.maxPerQuest) {
        return { ok: false, error: 'research_cap' }
      }
      const [created] = await tx`
        insert into research_calls (guild_id, hall_id, quest_id, member_id, made_at)
        values (${guildId}, ${input.hallId}, ${input.questId}, ${input.memberId}, ${input.at})
        returning call_id, hall_id, quest_id, member_id`
      const r = row.parse(created)
      const call: ResearchCall = {
        id: r.call_id,
        hallId: r.hall_id,
        questId: r.quest_id,
        memberId: r.member_id,
      }
      return { ok: true, call }
    })
  }

  async release(guildId: string, callId: string): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update research_calls set released_at = now()
        where guild_id = ${guildId} and call_id = ${callId} and released_at is null`
    )
  }

  async count(guildId: string, questId: string): Promise<number> {
    const [held] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select count(*)::int as n from research_calls
        where guild_id = ${guildId} and quest_id = ${questId} and released_at is null`
    )
    return counted.parse(held).n
  }

  async settle(guildId: string, callId: string): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update research_calls set settled_at = now()
        where guild_id = ${guildId} and call_id = ${callId} and settled_at is null`
    )
  }

  async stale(guildId: string, before: Date, limit: number): Promise<string[]> {
    return this.db.withGuild(guildId, async (tx) => {
      // A second replica sweeping the same guild skips; the work is idempotent either way.
      const [lock] = await tx`
        select pg_try_advisory_xact_lock(hashtextextended(${`research-sweep:${guildId}`}, 0)) as ok`
      if (!tried.parse(lock).ok) {
        return []
      }
      const rows = await tx`
        select call_id from research_calls
        where guild_id = ${guildId} and released_at is null and settled_at is null
          and made_at < ${before}
        order by made_at, call_id limit ${limit}`
      return rows.map((r) => ids.parse(r).call_id)
    })
  }

  async close(guildId: string, callId: string, outcome: 'freed' | 'settled'): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update research_calls
        set settled_at = coalesce(settled_at, now()),
            released_at = case when ${outcome === 'freed'} then coalesce(released_at, now()) else released_at end
        where guild_id = ${guildId} and call_id = ${callId}`
    )
  }
}
