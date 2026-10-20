import type { CostPerPostPage, PostCostReader } from './ports/post-cost-reader'

export type { CampaignPostCost, CostPerPostPage, PostCost } from './ports/post-cost-reader'

/** Collaborators of {@link costPerPost}. */
export interface CostPerPostDeps {
  postCosts: Pick<PostCostReader, 'byCampaign'>
}

/**
 * Cost per accepted post: every Quest whose Seal was consumed or posted counts as a post, and its
 * metered spend (0 when none) is its cost (spend on Quests whose Seal was denied, expired or never asked is not a post and is left out),
 * grouped per Campaign. `overall` covers every Campaign; `campaigns` is one page, ordered by
 * Campaign id with the no-Campaign group first, and `after` is the previous page's cursor.
 */
export function costPerPost(
  deps: CostPerPostDeps,
  guildId: string,
  page: { limit: number; after?: string }
): Promise<CostPerPostPage> {
  return deps.postCosts.byCampaign(guildId, page)
}
