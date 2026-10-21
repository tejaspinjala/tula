import { z } from 'zod'
import type { Db } from '../db/client'
import { memberRank } from '../guild-config'
import { dataClass } from '../ports/classifier'
import {
  BLOCK_REASONS,
  type LoggedRouting,
  MAX_ROUTING_PAGE,
  type RoutingEntry,
  type RoutingLog,
  type RoutingPage,
  routingEntry,
} from '../ports/routing-log'

const claim = z.object({ hallId: z.string(), rank: memberRank, dataClass })
const row = z.object({
  seq: z.coerce.number(),
  decision_key: z.string(),
  source: routingEntry.shape.source,
  goal_sha256: z.string().nullable(),
  hall_id: z.string().nullable(),
  rank: memberRank.nullable(),
  data_class: dataClass.nullable(),
  classifier_claim: claim.nullable(),
  outcome: z.enum(['routed', 'blocked']),
  provider_id: z.string().nullable(),
  profile_id: z.string().nullable(),
  reason: z.enum(BLOCK_REASONS).nullable(),
})

function toEntry(r: z.infer<typeof row>): LoggedRouting {
  return {
    seq: r.seq,
    decisionKey: r.decision_key,
    source: r.source,
    goalSha256: r.goal_sha256,
    hallId: r.hall_id,
    rank: r.rank,
    dataClass: r.data_class,
    classifierClaim: r.classifier_claim,
    outcome: r.outcome,
    providerId: r.provider_id,
    profileId: r.profile_id,
    reason: r.reason,
  }
}

/** Postgres {@link RoutingLog}: every call runs in `Db.withGuild`, so RLS scopes it to one guild. */
export class PgRoutingLog implements RoutingLog {
  constructor(private readonly db: Db) {}

  async record(guildId: string, e: RoutingEntry): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`
        insert into routing_decisions
          (guild_id, decision_key, source, goal_sha256, hall_id, rank, data_class,
           classifier_claim, outcome, provider_id, profile_id, reason)
        values (${guildId}, ${e.decisionKey}, ${e.source}, ${e.goalSha256}, ${e.hallId}, ${e.rank},
          ${e.dataClass}, (${e.classifierClaim === null ? null : JSON.stringify(e.classifierClaim)}::text)::jsonb,
          ${e.outcome}, ${e.providerId}, ${e.profileId}, ${e.reason})
        on conflict (guild_id, decision_key) do nothing`
    })
  }

  async list(guildId: string, page: { after?: number; limit: number }): Promise<RoutingPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_ROUTING_PAGE)
    const after = page.after ?? Number.MAX_SAFE_INTEGER
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select seq, decision_key, source, goal_sha256, hall_id, rank, data_class,
               classifier_claim, outcome, provider_id, profile_id, reason
        from routing_decisions
        where guild_id = ${guildId} and seq < ${after}
        order by seq desc limit ${limit + 1}`
    )
    const entries = rows.slice(0, limit).map((r) => toEntry(row.parse(r)))
    const last = entries.at(-1)
    return { entries, next: rows.length > limit && last ? last.seq : null }
  }

  async forKeys(guildId: string, decisionKeys: readonly string[]): Promise<LoggedRouting[]> {
    const keys = decisionKeys.slice(0, MAX_ROUTING_PAGE)
    if (keys.length === 0) {
      return []
    }
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select seq, decision_key, source, goal_sha256, hall_id, rank, data_class,
               classifier_claim, outcome, provider_id, profile_id, reason
        from routing_decisions
        where guild_id = ${guildId} and decision_key in ${tx(keys)}
        order by seq desc`
    )
    return rows.map((r) => toEntry(row.parse(r)))
  }
}
