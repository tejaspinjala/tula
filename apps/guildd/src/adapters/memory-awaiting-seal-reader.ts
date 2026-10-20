import type { AwaitingSealPage, AwaitingSealReader } from '../ports/awaiting-seal-reader'
import type { QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'

/**
 * Memory {@link AwaitingSealReader}, composed over the memory Quest queue and Seal store: the same
 * answer as the Postgres join, computed from their ports. State lives in those stores only.
 */
export class MemoryAwaitingSealReader implements AwaitingSealReader {
  constructor(_quests: Pick<QuestQueue, 'list'>, _seals: Pick<SealStore, 'forQuest'>) {}

  async due(_guildId: string, _page: { after?: string; limit: number }): Promise<AwaitingSealPage> {
    throw new Error('not implemented')
  }

  async hasWork(_guildId: string): Promise<boolean> {
    throw new Error('not implemented')
  }
}
