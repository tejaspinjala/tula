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
  _deps: CoreLoopDeps,
  _guildId: string
): Promise<{ settled: number }> {
  throw new Error('not implemented')
}
