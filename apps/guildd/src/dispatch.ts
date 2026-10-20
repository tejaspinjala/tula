import { type PendingSealDeps, reconcileSeals, requestPendingSeals } from './core-loop'
import { hallCaps, questConcurrency, sealPostWindowMs } from './guild-config'
import { type HallWatchDeps, watchHalls } from './hall-watch'
import type { McpGateway } from './mcp/gateway'
import { MICROS_PER_CENT } from './model-cost'
import { GatewayError, type ModelGateway } from './model-gateway'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import { ConfigError } from './ports/config-store'
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
  /** How long the sandbox may take to start before the Quest is released (default 30s). */
  sandboxStartTimeoutMs?: number
}

/** How long a sandbox start may take before {@link startRun} gives the Quest back. */
const SANDBOX_START_TIMEOUT_MS = 30_000

/** Why {@link startRun} did not leave a worker running. */
export type StartRunError =
  | 'gates_barred'
  | 'run_not_started'
  | 'sandbox_unavailable'
  | 'subscription_disabled'

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
    const spec = {
      questId: claimed.id,
      runToken: run.token,
      leaseHandle: JSON.stringify(await deps.mcp.lease(guildId, claimed)),
      doneCondition: claimed.doneCondition,
    }
    await startWithin(deps, guildId, spec)
  } catch (error) {
    await release(error instanceof SandboxStartTimeout ? 'timeout' : 'sandbox_unavailable')
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

/** The sandbox did not start within its bound; the Quest has been (or is being) given back. */
class SandboxStartTimeout extends Error {
  constructor() {
    super('sandbox_start_timeout')
  }
}

/**
 * Starts the sandbox, bounded by the start timeout. On timeout the caller releases the Quest, and a
 * container that comes up afterwards is stopped by its own id (never the Quest's, which a retry may
 * already have a new container for) and its result discarded: a start never outlives its lease.
 */
async function startWithin(
  deps: StartRunDeps,
  guildId: string,
  spec: Parameters<SandboxRunner['start']>[1]
): Promise<void> {
  const starting = deps.sandboxes.start(guildId, spec)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      deps.sandboxStartTimeoutMs ?? SANDBOX_START_TIMEOUT_MS
    )
  })
  try {
    if ((await Promise.race([starting, expired])) === 'timeout') {
      starting.then(
        (late) =>
          deps.sandboxes
            .kill({ guildId, questId: spec.questId, sandboxId: late.sandboxId })
            .catch(() => undefined),
        () => undefined
      )
      throw new SandboxStartTimeout()
    }
  } finally {
    clearTimeout(timer)
  }
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
    if (error instanceof GatewayError && error.code === 'subscription_disabled') {
      return { error: 'subscription_disabled' }
    }
    throw error
  }
}

/** Collaborators of {@link dispatch}. */
export type DispatchDeps = RoutingDeps &
  StartRunDeps &
  PendingSealDeps &
  HallWatchDeps & {
    quests: QuestQueue
    config: Pick<ConfigStore, 'current'>
  }

/** The guild's current config, or null when it has none applied (`not_found`); other errors propagate. */
async function currentConfig(
  deps: Pick<DispatchDeps, 'config'>,
  guildId: string
): Promise<Awaited<ReturnType<DispatchDeps['config']['current']>> | null> {
  try {
    return await deps.config.current(guildId)
  } catch (error) {
    if (error instanceof ConfigError && error.code === 'not_found') {
      return null
    }
    throw error
  }
}

/** What one {@link dispatch} pass did. */
export type DispatchOutcome =
  | { status: 'barred' }
  | { status: 'idle' }
  /** The guild has no applied config yet: nothing to dispatch, and not an error. */
  | { status: 'unconfigured' }
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
export async function dispatch(deps: DispatchDeps, guildId: string): Promise<DispatchOutcome> {
  if (await deps.gates.isBarred(guildId)) {
    return { status: 'barred' }
  }
  const current = await currentConfig(deps, guildId)
  if (current === null) {
    return { status: 'unconfigured' }
  }
  const { config } = current
  await reconcileSeals(
    { quests: deps.quests, seals: deps.sealStore, awaiting: deps.awaiting },
    guildId,
    sealPostWindowMs(config)
  )
  await requestPendingSeals(deps, guildId)
  // Runs that just settled (Seals posted or rejected, Quests failed) feed the Tripwires before any claim.
  await watchHalls(deps, guildId)
  const claimed = await deps.quests.claim(guildId, {
    leaseMs: DISPATCH_LEASE_MS,
    maxActive: questConcurrency(config),
    hallCaps: hallCaps(config),
  })
  if (claimed === null) {
    return { status: 'idle' }
  }
  const routed = await routeClaimed(deps, guildId, claimed)
  if (routed.status === 'blocked') {
    return {
      status: 'blocked',
      questId: claimed.id,
      reason: routed.reason,
      disposition: routed.disposition,
    }
  }
  const started = await startRun(deps, guildId, claimed, routed.profileId)
  return started.ok
    ? { status: 'started', questId: claimed.id, profileId: routed.profileId }
    : { status: 'failed', questId: claimed.id, error: started.error }
}

/** The dispatcher bound to its collaborators; what the app and the job hook call. */
export class Dispatcher {
  constructor(private readonly deps: DispatchDeps) {}

  /** Runs one {@link dispatch} pass for the guild. */
  dispatch(guildId: string): Promise<DispatchOutcome> {
    return dispatch(this.deps, guildId)
  }
}

/**
 * The job hook: one dispatch pass for each guild given, in order, keeping no cron state (the
 * caller supplies the guilds and the schedule). A failing guild does not stop the rest; its error
 * is returned beside the outcomes.
 */
export async function dispatchAll(
  dispatcher: Pick<Dispatcher, 'dispatch'>,
  guildIds: readonly string[]
): Promise<
  Array<{ guildId: string; outcome: DispatchOutcome } | { guildId: string; error: unknown }>
> {
  const results: Array<
    { guildId: string; outcome: DispatchOutcome } | { guildId: string; error: unknown }
  > = []
  for (const guildId of guildIds) {
    try {
      results.push({ guildId, outcome: await dispatcher.dispatch(guildId) })
    } catch (error) {
      results.push({ guildId, error })
    }
  }
  return results
}
