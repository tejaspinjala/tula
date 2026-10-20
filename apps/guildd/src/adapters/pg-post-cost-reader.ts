import { z } from 'zod'
import type { Db } from '../db/client'
import {
  type CostPerPostPage,
  MAX_POST_COST_PAGE,
  type PostCostReader,
} from '../ports/post-cost-reader'

const groupRow = z.object({
  campaign_id: z.string().nullable(),
  key: z.string(),
  posts: z.coerce.number(),
  cost_micros: z.coerce.number(),
  all_posts: z.coerce.number(),
  all_cost_micros: z.coerce.number(),
})

/**
 * Postgres {@link PostCostReader}: one aggregate per page. Consumed Seals (distinct per Quest) join
 * their Quest for the Campaign and the ledger's per-Quest spend, grouped by Campaign. The window
 * totals are taken over every group before the keyset cursor narrows the page, so `overall` covers
 * all Campaigns while only `limit + 1` groups leave the database.
 */
export class PgPostCostReader implements PostCostReader {
  constructor(private readonly db: Db) {}

  async byCampaign(
    guildId: string,
    page: { limit: number; after?: string }
  ): Promise<CostPerPostPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_POST_COST_PAGE)
    const after = page.after ?? null
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from (
          select campaign_id, key, posts, cost_micros,
                 sum(posts) over () as all_posts, sum(cost_micros) over () as all_cost_micros
          from (
          select q.campaign_id, coalesce(q.campaign_id, '') as key,
                 count(*) as posts, coalesce(sum(u.cost_micros), 0) as cost_micros
          from (
            select distinct quest_id from seals
            where guild_id = ${guildId} and status = 'consumed'
          ) p
          join quests q on q.guild_id = ${guildId} and q.quest_id = p.quest_id
          left join (
            select quest_id, sum(cost_micros) as cost_micros from model_usage
            where guild_id = ${guildId} group by quest_id
          ) u on u.quest_id = p.quest_id::text
          group by q.campaign_id
          ) groups
        ) windowed
        where ${after}::text is null or key > ${after}::text
        order by key limit ${limit + 1}`
    )
    const parsed = rows.map((r) => groupRow.parse(r))
    const first = parsed[0]
    const slice = parsed.slice(0, limit)
    const last = slice.at(-1)
    const cost = (posts: number, costMicros: number) => ({
      posts,
      costMicros,
      costPerPostMicros: Math.floor(costMicros / posts),
    })
    return {
      overall: first
        ? cost(first.all_posts, first.all_cost_micros)
        : { posts: 0, costMicros: 0, costPerPostMicros: 0 },
      campaigns: slice.map((g) => ({
        campaignId: g.campaign_id,
        ...cost(g.posts, g.cost_micros),
      })),
      next: parsed.length > limit && last ? last.key : null,
    }
  }
}
