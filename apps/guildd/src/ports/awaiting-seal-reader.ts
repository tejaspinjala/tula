import type { Quest } from './quest-queue'
import type { Seal } from './seal-store'

/** Largest page an {@link AwaitingSealReader} call returns. */
export const MAX_AWAITING_SEAL_PAGE = 100

/** A Quest held in `awaiting_seal` with the Seal of its latest round, or null when it never asked. */
export interface AwaitingSeal {
  quest: Quest
  /** The Seal of the Quest's latest Seal round (see `SealStore.forQuest`); may be an earlier round than the Quest's. */
  seal: Seal | null
}

/** One page of {@link AwaitingSeal} in Quest `seq` order; `next` is the cursor for the following page, null at the end. */
export interface AwaitingSealPage {
  items: AwaitingSeal[]
  next: string | null
}

/**
 * Read port for the Core Loop's Seal passes. Answers, in one read, which `awaiting_seal` Quests
 * have something to do and the Seal each is waiting on, so a pass reads only those Quests instead
 * of every held Quest and a Seal lookup per Quest.
 */
export interface AwaitingSealReader {
  /**
   * The `awaiting_seal` Quests of the guild that a pass has work for, in `seq` order strictly after
   * `after`, at most `limit`: the Quest has no Seal for its current round (to ask for one), or
   * the Seal of its current round has ended (consumed, denied or expired; to settle). A Quest
   * waiting on a live Seal (requested, approved, reserved or released) is left out.
   */
  due(guildId: string, page: { after?: string; limit: number }): Promise<AwaitingSealPage>
  /** Whether {@link due} would return anything: a cheap check before a pass scans. */
  hasWork(guildId: string): Promise<boolean>
}
