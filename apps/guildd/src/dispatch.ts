import { type PendingSealDeps, reconcileSeals, requestPendingSeals } from './core-loop'
import { questConcurrency } from './guild-config'
import type { McpGateway } from './mcp/gateway'
import { MICROS_PER_CENT } from './model-cost'
import { GatewayError, type ModelGateway } from './model-gateway'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { GateStore } from './ports/gate-store'
import type { ModelLedger } from './ports/model-ledger'
import { type Quest, type QuestQueue, retryDelayMs } from './ports/quest-queue'
import type { BlockReason } from './ports/routing-log'
import type { SandboxRunner } from './ports/sandbox-runner'
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

/** Collaborators of {@link startRun}. */
export interface StartRunDeps {
  quests: Pick<QuestQueue, 'fail'>
  gates: Pick<GateStore, 'isBarred'>
  gateway: Pick<ModelGateway, 'openRun'>
  mcp: Pick<McpGateway, 'lease'>
  sandboxes: Pick<SandboxRunner, 'start' | 'kill'>
}

/** Why {@link startRun} did not leave a worker running. */
export type StartRunError =
  | 'gates_barred'
  | 'run_not_started'
  | 'sandbox_unavailable'
  | 'subscription_unsupported_until_spike_15'

/**
 * Starts the worker of a Quest this caller has just claimed: opens its run, leases the MCP
 * session, starts the sandbox, and re-checks the bar once the container is up. On any refusal the
 * Quest is failed with a coded reason so it never keeps a live lease no worker will use. Shared by
 * Summon and the dispatcher. A throw from the run gateway fails the Quest and is rethrown.
 */
export async function startRun(
  deps: StartRunDeps,
  guildId: string,
  claimed: Quest,
  profileId: string
): Promise<{ ok: true } | { ok: false; error: StartRunError }> {
  const release = (reason: string) =>
    deps.quests.fail(guildId, claimed.id, claimed.attempts, reason)
  let run: Awaited<ReturnType<typeof openRun>>
  try {
    run = await openRun(deps, guildId, claimed, profileId)
  } catch (error) {
    await release('provider_error')
    throw error
  }
  if (!('token' in run)) {
    await release('routing_blocked')
    return { ok: false, error: run.error }
  }
  try {
    await deps.sandboxes.start(guildId, {
      questId: claimed.id,
      runToken: run.token,
      leaseHandle: JSON.stringify(await deps.mcp.lease(guildId, claimed)),
      doneCondition: claimed.doneCondition,
    })
  } catch {
    await release('sandbox_unavailable')
    return { ok: false, error: 'sandbox_unavailable' }
  }
  // A bar that landed while the container started could not see it yet: stop it here.
  if (await deps.gates.isBarred(guildId)) {
    try {
      await deps.sandboxes.kill({ guildId })
    } catch {
      // The kill was not confirmed: end the Quest as failed rather than leave it leased.
      await release('sandbox_unavailable')
      return { ok: false, error: 'sandbox_unavailable' }
    }
    await release('routing_blocked')
    return { ok: false, error: 'gates_barred' }
  }
  return { ok: true }
}

async function openRun(
  deps: StartRunDeps,
  guildId: string,
  claimed: Quest,
  profileId: string
): Promise<{ token: string } | { error: StartRunError }> {
  try {
    const run = await deps.gateway.openRun(guildId, {
      questId: claimed.id,
      attempt: claimed.attempts,
      hallId: claimed.hallId,
      profileId,
    })
    if (run.status === 'started') {
      return { token: run.token }
    }
    return {
      error:
        run.status === 'refused' && run.reason === 'gates_barred'
          ? 'gates_barred'
          : 'run_not_started',
    }
  } catch (error) {
    if (error instanceof GatewayError && error.code === 'subscription_unsupported_until_spike_15') {
      return { error: 'subscription_unsupported_until_spike_15' }
    }
    throw error
  }
}

/** Collaborators of {@link dispatch}. */
export type DispatchDeps = RoutingDeps &
  StartRunDeps &
  PendingSealDeps & {
    quests: QuestQueue
    config: Pick<ConfigStore, 'current'>
  }

/** What one {@link dispatch} pass did. */
export type DispatchOutcome =
  | { status: 'barred' }
  | { status: 'idle' }
  | {
      status: 'blocked'
      questId: string
      reason: BlockReason
      disposition: 'killed' | 'retry_scheduled'
    }
  | { status: 'started'; questId: string; profileId: string }
  | { status: 'failed'; questId: string; error: StartRunError }

/** How long a dispatched Quest's lease lasts: the worker's whole run. */
const DISPATCH_LEASE_MS = 10 * 60_000

/**
 * One pass of the dispatcher for a guild: refuses while the Gates are barred, settles finished
 * Seals, requests the Seals that are due, then claims at most one Quest, routes it and starts its
 * worker. Deterministic code; idempotent, so a rerun or two workers at once do no harm.
 */
export async function dispatch(_deps: DispatchDeps, _guildId: string): Promise<DispatchOutcome> {
  return { status: 'idle' }
}
