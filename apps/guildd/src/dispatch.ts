import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import type { Quest, QuestQueue } from './ports/quest-queue'
import type { BlockReason } from './ports/routing-log'
import type { RouteDeps } from './routing'

/** Collaborators of {@link routeClaimed}. */
export interface RoutingDeps {
  config: Pick<ConfigStore, 'current'>
  quests: Pick<QuestQueue, 'kill' | 'releaseClaim'>
  routing: RouteDeps
  ledger: Pick<ModelLedger, 'dayTotals'>
  clock: Clock
  /** Returns [0, 1); jitters the backoff of a transient block. */
  random: () => number
  /** Hosted (v2) deployments reject subscription providers. */
  hosted: boolean
}

/** What {@link routeClaimed} did with a claimed Quest. */
export type RoutedClaim =
  | { status: 'routed'; profileId: string; providerId: string }
  | {
      status: 'blocked'
      reason: BlockReason
      /** `killed`: permanent, dead-lettered; `retry_scheduled`: transient, queued with a delay. */
      disposition: 'killed' | 'retry_scheduled'
    }

/**
 * Routes a claimed Quest from its typed fields (never free text). A permanent block kills it with
 * the coded reason; a transient one releases the claim until a jittered backoff passes, spending
 * no attempt. Deterministic code; no model decides.
 */
export async function routeClaimed(
  _deps: RoutingDeps,
  _guildId: string,
  _quest: Quest
): Promise<RoutedClaim> {
  throw new Error('not implemented')
}
