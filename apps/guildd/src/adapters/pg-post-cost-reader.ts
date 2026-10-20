import type { Db } from '../db/client'
import type { CostPerPostPage, PostCostReader } from '../ports/post-cost-reader'

/** Postgres {@link PostCostReader}: one aggregate over the ledger, consumed Seals and Quests. */
export class PgPostCostReader implements PostCostReader {
  constructor(_db: Db) {}

  async byCampaign(
    _guildId: string,
    _page: { limit: number; after?: string }
  ): Promise<CostPerPostPage> {
    throw new Error('not implemented')
  }
}
