import { MICROS_PER_CENT } from './model-cost'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger } from './ports/model-ledger'
import { type Quest, type QuestQueue, retryDelayMs } from './ports/quest-queue'
import type { BlockReason } from './ports/routing-log'
import { type ProviderBudget, type RouteDeps, route } from './routing'

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
  deps: RoutingDeps,
  guildId: string,
  quest: Quest
): Promise<RoutedClaim> {
  const { config } = await deps.config.current(guildId)
  const totals = await deps.ledger.dayTotals(guildId, deps.clock.now().toISOString().slice(0, 10))
  const budget: ProviderBudget = {
    tokensRemaining: Math.max(0, config.caps.dailyTokens - totals.tokens),
    centsRemaining: Math.floor(
      Math.max(0, config.caps.dailySpendCents * MICROS_PER_CENT - totals.costMicros) /
        MICROS_PER_CENT
    ),
  }
  const providerIds = config.providers.map((p) => p.id)
  const outcome = await route(
    {
      guildId,
      decisionKey: `${quest.id}:${quest.attempts}`,
      config,
      work: {
        kind: 'template',
        hallId: quest.hallId,
        rank: quest.rank,
        dataClass: quest.dataClass,
      },
      // The daily caps are guild-wide, so every provider shares the same remaining allowance.
      budgets: Object.fromEntries(providerIds.map((id) => [id, budget])),
      // No health probe exists yet: a configured provider counts as available.
      available: providerIds,
      hosted: deps.hosted,
      estimate: { tokens: 1, cents: 1 },
    },
    deps.routing
  )
  if (outcome.status === 'routed') {
    return { status: 'routed', profileId: outcome.profileId, providerId: outcome.providerId }
  }
  if (PERMANENT.includes(outcome.reason)) {
    await deps.quests.kill(guildId, quest.id, quest.attempts, outcome.reason)
    return { status: 'blocked', reason: outcome.reason, disposition: 'killed' }
  }
  const delay = retryDelayMs(quest.attempts, deps.random())
  await deps.quests.releaseClaim(
    guildId,
    quest.id,
    quest.attempts,
    new Date(deps.clock.now().getTime() + delay)
  )
  return { status: 'blocked', reason: outcome.reason, disposition: 'retry_scheduled' }
}

/** Blocks no wait can fix: the Quest dies with its coded reason. */
const PERMANENT: readonly BlockReason[] = [
  'hall_locked',
  'hall_not_found',
  'private_provider_unavailable',
]
