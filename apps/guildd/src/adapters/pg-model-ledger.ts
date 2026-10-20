import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { KeyProvider } from '../ports/key-provider'
import {
  isUsageDate,
  MAX_USAGE_PAGE,
  type ModelLedger,
  type NewRun,
  type Reservation,
  type ReserveResult,
  type RunRecord,
  type Totals,
  type UsageGroup,
  type UsagePage,
} from '../ports/model-ledger'

const iso = z
  .date()
  .nullable()
  .transform((d) => (d ? d.toISOString() : null))
const runRow = z.object({
  run_id: z.string(),
  quest_id: z.string(),
  hall_id: z.string(),
  provider_id: z.string(),
  profile_id: z.string(),
  state: z.enum(['queued', 'active', 'revoked']),
  expires_at: iso,
})
const usageRow = z.object({
  k: z.string(),
  calls: z.coerce.number(),
  input_tokens: z.coerce.number(),
  output_tokens: z.coerce.number(),
  cost_micros: z.coerce.number(),
})
const totalsRow = z.object({ tokens: z.coerce.number(), cost_micros: z.coerce.number() })

const toRun = (r: z.infer<typeof runRow>): RunRecord => ({
  runId: r.run_id,
  questId: r.quest_id,
  hallId: r.hall_id,
  providerId: r.provider_id,
  profileId: r.profile_id,
  state: r.state,
  expiresAt: r.expires_at,
})

const COLUMN: Record<UsageGroup, string> = {
  run: 'run_id',
  quest: 'quest_id',
  hall: 'hall_id',
  day: 'day',
}

/**
 * Postgres {@link ModelLedger}: every call runs in `Db.withGuild`, so forced RLS scopes it to one
 * guild. The once-a-day cap notice appends its `steward.cap_reached` event in the same
 * transaction as the dedupe row, so the event exists exactly when the row does.
 */
export class PgModelLedger implements ModelLedger {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async openRun(guildId: string, run: NewRun): Promise<'created' | 'exists'> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into model_runs
          (guild_id, run_id, quest_id, hall_id, provider_id, profile_id, state, token_hash, expires_at)
        values (${guildId}, ${run.runId}, ${run.questId}, ${run.hallId}, ${run.providerId},
          ${run.profileId}, ${run.state}, ${run.tokenHash}, ${run.expiresAt})
        on conflict (guild_id, run_id) do nothing
        returning run_id`
    )
    return rows.length === 1 ? 'created' : 'exists'
  }

  async activate(
    guildId: string,
    runId: string,
    tokenHash: string,
    expiresAt: string
  ): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        update model_runs set state = 'active', token_hash = ${tokenHash}, expires_at = ${expiresAt}
        where guild_id = ${guildId} and run_id = ${runId} and state = 'queued'
        returning run_id`
    )
    return rows.length === 1
  }

  async findByTokenHash(guildId: string, tokenHash: string): Promise<RunRecord | null> {
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select run_id, quest_id, hall_id, provider_id, profile_id, state, expires_at
        from model_runs where guild_id = ${guildId} and token_hash = ${tokenHash}`
    )
    return row ? toRun(runRow.parse(row)) : null
  }

  async getRun(guildId: string, runId: string): Promise<RunRecord | null> {
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select run_id, quest_id, hall_id, provider_id, profile_id, state, expires_at
        from model_runs where guild_id = ${guildId} and run_id = ${runId}`
    )
    return row ? toRun(runRow.parse(row)) : null
  }

  async revoke(guildId: string, runId: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        update model_runs set state = 'revoked'
        where guild_id = ${guildId} and run_id = ${runId} returning run_id`
    )
    return rows.length === 1
  }

  async listQueued(guildId: string, limit: number): Promise<RunRecord[]> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select run_id, quest_id, hall_id, provider_id, profile_id, state, expires_at
        from model_runs where guild_id = ${guildId} and state = 'queued'
        order by seq limit ${Math.min(Math.max(limit, 0), MAX_USAGE_PAGE)}`
    )
    return rows.map((r) => toRun(runRow.parse(r)))
  }

  // One transaction per guild at a time (advisory lock) so the cap check and the charge are
  // atomic: parallel calls cannot all pass a cap that admits one.
  async reserve(guildId: string, r: Reservation): Promise<ReserveResult> {
    return this.db.withGuild(guildId, async (tx): Promise<ReserveResult> => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${guildId}, 26))`
      if (r.clientKey !== null) {
        const dup = await tx`
          select 1 as one from model_usage
          where guild_id = ${guildId} and run_id = ${r.runId} and client_key = ${r.clientKey}`
        if (dup.length > 0) {
          return { status: 'duplicate' }
        }
      }
      const [row] = await tx`
        select coalesce(sum(input_tokens + output_tokens), 0) as tokens,
               coalesce(sum(cost_micros), 0) as cost_micros
        from model_usage where guild_id = ${guildId} and day = ${r.day}::date`
      const totals = totalsRow.parse(row)
      if (totals.tokens + r.inputTokens + r.outputTokens > r.caps.tokens) {
        return { status: 'cap_reached', reason: 'daily_tokens' }
      }
      if (totals.cost_micros + (r.costMicros ?? 0) > r.caps.costMicros) {
        return { status: 'cap_reached', reason: 'daily_spend' }
      }
      const inserted = await tx`
        insert into model_usage
          (guild_id, call_key, run_id, quest_id, hall_id, day, input_tokens, output_tokens,
           cost_micros, state, client_key)
        select guild_id, ${r.callKey}, run_id, quest_id, hall_id, ${r.day}::date,
               ${r.inputTokens}, ${r.outputTokens}, ${r.costMicros}, 'pending', ${r.clientKey}
        from model_runs where guild_id = ${guildId} and run_id = ${r.runId}
        returning call_key`
      if (inserted.length === 0) {
        throw new Error('usage for an unknown run')
      }
      return { status: 'reserved' }
    })
  }

  async settle(
    guildId: string,
    callKey: string,
    actual: { inputTokens: number; outputTokens: number; costMicros: number | null }
  ): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        update model_usage set input_tokens = ${actual.inputTokens},
          output_tokens = ${actual.outputTokens}, cost_micros = ${actual.costMicros},
          state = 'settled'
        where guild_id = ${guildId} and call_key = ${callKey}`
    )
  }

  async dayTotals(guildId: string, day: string): Promise<Totals> {
    const [row] = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select coalesce(sum(input_tokens + output_tokens), 0) as tokens,
               coalesce(sum(cost_micros), 0) as cost_micros
        from model_usage where guild_id = ${guildId} and day = ${day}::date`
    )
    const parsed = totalsRow.parse(row)
    return { tokens: parsed.tokens, costMicros: parsed.cost_micros }
  }

  async report(
    guildId: string,
    by: UsageGroup,
    page: { after?: string; limit: number }
  ): Promise<UsagePage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_USAGE_PAGE)
    const after = page.after ?? null
    if (by === 'day' && after !== null && !isUsageDate(after)) {
      return { rows: [], next: null }
    }
    const rows = await this.db.withGuild(
      guildId,
      // The cursor filters the grouping column itself (not a computed key) so each grouping's
      // index narrows the scan before anything is aggregated.
      (tx) => {
        const col = tx(COLUMN[by])
        const past =
          after === null
            ? tx`true`
            : by === 'day'
              ? tx`${col} > ${after}::date`
              : tx`${col} > ${after}`
        return tx`
          select ${col}::text as k, count(*) as calls, sum(input_tokens) as input_tokens,
                 sum(output_tokens) as output_tokens, coalesce(sum(cost_micros), 0) as cost_micros
          from model_usage where guild_id = ${guildId} and ${past}
          group by ${col} order by ${col} limit ${limit + 1}`
      }
    )
    const parsed = rows.map((r) => usageRow.parse(r))
    const out = parsed.slice(0, limit).map((r) => ({
      key: r.k,
      calls: r.calls,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      costMicros: r.cost_micros,
    }))
    const last = out.at(-1)
    return { rows: out, next: parsed.length > limit && last ? last.key : null }
  }

  async noteCapReached(guildId: string, day: string, reason: string): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        insert into model_cap_notices (guild_id, day, reason)
        values (${guildId}, ${day}::date, ${reason})
        on conflict (guild_id, day) do nothing returning day`
      if (rows.length === 0) {
        return false
      }
      await appendEvent(tx, this.keys, 'steward.cap_reached', { day, reason })
      return true
    })
  }
}
