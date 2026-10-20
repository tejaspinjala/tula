import type { ModelLedger } from '../ports/model-ledger'
import {
  type CostPerPostPage,
  MAX_POST_COST_PAGE,
  type PostCost,
  type PostCostReader,
} from '../ports/post-cost-reader'
import type { QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'

function cost(g: { posts: number; costMicros: number }): PostCost {
  return {
    posts: g.posts,
    costMicros: g.costMicros,
    costPerPostMicros: Math.floor(g.costMicros / g.posts),
  }
}

/** Memory {@link PostCostReader}, composed over the memory ledger, Quest queue and Seal store. */
export class MemoryPostCostReader implements PostCostReader {
  constructor(
    private readonly deps: {
      ledger: Pick<ModelLedger, 'report'>
      quests: Pick<QuestQueue, 'get'>
      sealStore: Pick<SealStore, 'list'>
    }
  ) {}

  async byCampaign(
    guildId: string,
    page: { limit: number; after?: string }
  ): Promise<CostPerPostPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_POST_COST_PAGE)
    const groups = new Map<
      string,
      { campaignId: string | null; posts: number; costMicros: number }
    >()
    const spend = new Map<string, number>()
    let spendCursor: string | undefined
    do {
      const rows = await this.deps.ledger.report(guildId, 'quest', {
        limit: 100,
        ...(spendCursor === undefined ? {} : { after: spendCursor }),
      })
      for (const row of rows.rows) {
        spend.set(row.key, row.costMicros)
      }
      spendCursor = rows.next ?? undefined
    } while (spendCursor !== undefined)
    // Every Quest with a consumed Seal is a post, metered or not (no spend costs 0).
    const counted = new Set<string>()
    let cursor: string | undefined
    do {
      const seals = await this.deps.sealStore.list(guildId, {
        limit: 100,
        status: 'consumed',
        ...(cursor === undefined ? {} : { after: cursor }),
      })
      for (const seal of seals.seals) {
        if (counted.has(seal.questId)) {
          continue
        }
        counted.add(seal.questId)
        const quest = await this.deps.quests.get(guildId, seal.questId)
        const campaignId = quest?.campaignId ?? null
        const group = groups.get(campaignId ?? '') ?? { campaignId, posts: 0, costMicros: 0 }
        group.posts += 1
        group.costMicros += spend.get(seal.questId) ?? 0
        groups.set(campaignId ?? '', group)
      }
      cursor = seals.next ?? undefined
    } while (cursor !== undefined)
    const ordered = [...groups.entries()]
      .filter(([key]) => page.after === undefined || key > page.after)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const slice = ordered.slice(0, limit)
    const last = slice.at(-1)
    const all = [...groups.values()]
    const total = all.reduce(
      (acc, g) => ({ posts: acc.posts + g.posts, costMicros: acc.costMicros + g.costMicros }),
      { posts: 0, costMicros: 0 }
    )
    return {
      overall: all.length === 0 ? { posts: 0, costMicros: 0, costPerPostMicros: 0 } : cost(total),
      campaigns: slice.map(([, g]) => ({ campaignId: g.campaignId, ...cost(g) })),
      next: ordered.length > limit && last ? last[0] : null,
    }
  }
}
