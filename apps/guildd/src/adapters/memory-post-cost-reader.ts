import type { ModelLedger } from '../ports/model-ledger'
import type { CostPerPostPage, PostCostReader } from '../ports/post-cost-reader'
import type { QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'

/** Memory {@link PostCostReader}, composed over the memory ledger, Quest queue and Seal store. */
export class MemoryPostCostReader implements PostCostReader {
  constructor(_deps: {
    ledger: Pick<ModelLedger, 'report'>
    quests: Pick<QuestQueue, 'get'>
    sealStore: Pick<SealStore, 'list'>
  }) {}

  async byCampaign(
    _guildId: string,
    _page: { limit: number; after?: string }
  ): Promise<CostPerPostPage> {
    throw new Error('not implemented')
  }
}
