import {
  type AwaitingSeal,
  type AwaitingSealPage,
  type AwaitingSealReader,
  MAX_AWAITING_SEAL_PAGE,
} from '../ports/awaiting-seal-reader'
import type { QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'

/**
 * Memory {@link AwaitingSealReader}, composed over the memory Quest queue and Seal store: the same
 * answer as the Postgres join, computed from their ports. State lives in those stores only.
 */
export class MemoryAwaitingSealReader implements AwaitingSealReader {
  constructor(
    private readonly quests: Pick<QuestQueue, 'list'>,
    private readonly seals: Pick<SealStore, 'forQuest'>
  ) {}

  async due(guildId: string, page: { after?: string; limit: number }): Promise<AwaitingSealPage> {
    const limit = Math.min(Math.max(page.limit, 1), MAX_AWAITING_SEAL_PAGE)
    const items: AwaitingSeal[] = []
    let after = page.after
    do {
      const held = await this.quests.list(guildId, {
        limit: MAX_AWAITING_SEAL_PAGE,
        state: 'awaiting_seal',
        ...(after === undefined ? {} : { after }),
      })
      for (const quest of held.quests) {
        const seal = await this.seals.forQuest(guildId, quest.id)
        const live =
          seal !== null &&
          seal.round === quest.round &&
          seal.status !== 'consumed' &&
          seal.status !== 'denied' &&
          seal.status !== 'expired'
        if (live) {
          continue
        }
        if (items.length === limit) {
          const last = items.at(-1)
          return { items, next: last ? String(last.quest.seq) : null }
        }
        items.push({ quest, seal })
      }
      after = held.next ?? undefined
    } while (after !== undefined)
    return { items, next: null }
  }

  async hasWork(guildId: string): Promise<boolean> {
    return (await this.due(guildId, { limit: 1 })).items.length > 0
  }
}
