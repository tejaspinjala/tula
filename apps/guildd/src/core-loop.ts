import type { QuestQueue } from './ports/quest-queue'
import type { SealStore } from './ports/seal-store'

/** Collaborators of {@link reconcileSeals}. */
export interface CoreLoopDeps {
  quests: QuestQueue
  seals: Pick<SealStore, 'forQuest'>
}

/**
 * Settles every Quest of the guild held in `awaiting_seal` whose Seal for the Quest's current
 * round has ended: consumed or posted finishes it; denied or expired sends it to a revision round
 * or the dead letters (see `QuestQueue.settleSeal`). Deterministic and keyed by quest id, so
 * a rerun, or two workers at once, change nothing. Returns how many Quests it settled.
 */
export async function reconcileSeals(
  deps: CoreLoopDeps,
  guildId: string
): Promise<{ settled: number }> {
  let settled = 0
  let after: string | undefined
  do {
    const page = await deps.quests.list(guildId, {
      limit: 100,
      state: 'awaiting_seal',
      ...(after === undefined ? {} : { after }),
    })
    for (const quest of page.quests) {
      const seal = await deps.seals.forQuest(guildId, quest.id)
      if (!seal || seal.round !== quest.round) {
        continue
      }
      const outcome =
        seal.status === 'consumed'
          ? 'posted'
          : seal.status === 'denied' || seal.status === 'expired'
            ? 'rejected'
            : null
      if (outcome !== null) {
        await deps.quests.settleSeal(guildId, quest.id, outcome)
        settled += 1
      }
    }
    after = page.next ?? undefined
  } while (after !== undefined)
  return { settled }
}
