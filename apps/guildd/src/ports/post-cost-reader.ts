/** Largest page a {@link PostCostReader.byCampaign} call returns. */
export const MAX_POST_COST_PAGE = 100

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

/** One page of {@link PostCostReader.byCampaign}. */
export interface CostPerPostPage {
  overall: PostCost
  campaigns: CampaignPostCost[]
  next: string | null
}

/**
 * Read port for cost per accepted post. Every Quest whose Seal was consumed or posted counts as a
 * post exactly once, and its metered spend (0 when none) is its cost; spend on Quests whose Seal
 * was denied, expired or never asked is not a post and is left out. Grouped per Campaign.
 */
export interface PostCostReader {
  /**
   * `overall` covers every Campaign; `campaigns` is one page ordered by Campaign id with the
   * no-Campaign group first, strictly after the cursor `after` (the previous page's `next`).
   * The cost of a page does not grow with the number of posts or pages.
   */
  byCampaign(guildId: string, page: { limit: number; after?: string }): Promise<CostPerPostPage>
}
