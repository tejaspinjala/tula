import type { ModelLedger } from './ports/model-ledger'
import type { QuestQueue } from './ports/quest-queue'
import type { SealStore } from './ports/seal-store'

/** Collaborators of {@link costPerPost}. */
export interface CostPerPostDeps {
  ledger: Pick<ModelLedger, 'report'>
  quests: Pick<QuestQueue, 'get'>
  sealStore: Pick<SealStore, 'forQuest'>
}

/** Accepted posts and what they cost, in millionths of a cent. */
export interface PostCost {
  posts: number
  costMicros: number
  /** The whole-number average (rounded down); zero posts cannot appear, so never divides by zero. */
  costPerPostMicros: number
}

/** The cost of one Campaign's accepted posts; `campaignId` null groups Quests outside any Campaign. */
export interface CampaignPostCost extends PostCost {
  campaignId: string | null
}

/** One page of {@link costPerPost}. */
export interface CostPerPostPage {
  overall: PostCost
  campaigns: CampaignPostCost[]
  next: string | null
}

/**
 * Cost per accepted post: the metered spend of each Quest whose Seal was consumed or posted
 * (spend on Quests whose Seal was denied, expired or never asked is not a post and is left out),
 * grouped per Campaign. `overall` covers every Campaign; `campaigns` is one page, ordered by
 * Campaign id with the no-Campaign group first, and `after` is the previous page's cursor.
 */
export async function costPerPost(
  deps: CostPerPostDeps,
  guildId: string,
  page: { limit: number; after?: string }
): Promise<CostPerPostPage> {
  const groups = new Map<string, { campaignId: string | null; posts: number; costMicros: number }>()
  let cursor: string | undefined
  do {
    const rows = await deps.ledger.report(guildId, 'quest', {
      limit: 100,
      ...(cursor === undefined ? {} : { after: cursor }),
    })
    for (const row of rows.rows) {
      const seal = await deps.sealStore.forQuest(guildId, row.key)
      if (seal?.status !== 'consumed') {
        continue
      }
      const quest = await deps.quests.get(guildId, row.key)
      const campaignId = quest?.campaignId ?? null
      const group = groups.get(campaignId ?? '') ?? { campaignId, posts: 0, costMicros: 0 }
      group.posts += 1
      group.costMicros += row.costMicros
      groups.set(campaignId ?? '', group)
    }
    cursor = rows.next ?? undefined
  } while (cursor !== undefined)
  const cost = (g: { posts: number; costMicros: number }): PostCost => ({
    posts: g.posts,
    costMicros: g.costMicros,
    costPerPostMicros: Math.floor(g.costMicros / g.posts),
  })
  const ordered = [...groups.entries()]
    .filter(([key]) => page.after === undefined || key > page.after)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  const slice = ordered.slice(0, page.limit)
  const last = slice.at(-1)
  const all = [...groups.values()]
  return {
    overall: all.length === 0 ? { posts: 0, costMicros: 0, costPerPostMicros: 0 } : cost(sum(all)),
    campaigns: slice.map(([, g]) => ({ campaignId: g.campaignId, ...cost(g) })),
    next: ordered.length > page.limit && last ? last[0] : null,
  }
}

function sum(groups: ReadonlyArray<{ posts: number; costMicros: number }>) {
  return groups.reduce(
    (acc, g) => ({ posts: acc.posts + g.posts, costMicros: acc.costMicros + g.costMicros }),
    { posts: 0, costMicros: 0 }
  )
}
