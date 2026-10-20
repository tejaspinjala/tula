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
  _deps: CostPerPostDeps,
  _guildId: string,
  _page: { limit: number; after?: string }
): Promise<CostPerPostPage> {
  return { overall: { posts: 0, costMicros: 0, costPerPostMicros: 0 }, campaigns: [], next: null }
}
