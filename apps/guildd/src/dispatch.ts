import { type PendingSealDeps, reconcileSeals, requestPendingSeals } from './core-loop'
import { claimLimits, lockedHallIds, sealPostWindowMs } from './guild-config'
import { type HallWatchDeps, watchHalls } from './hall-watch'
import type { McpGateway } from './mcp/gateway'
import { MICROS_PER_CENT } from './model-cost'
import { GatewayError, type ModelGateway, runIdFor } from './model-gateway'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import { ConfigError } from './ports/config-store'
import type { GateStore } from './ports/gate-store'
import type { ModelLedger } from './ports/model-ledger'
import { MAX_QUEST_PAGE, type Quest, type QuestQueue, retryDelayMs } from './ports/quest-queue'
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

/** Blocks no wait can fix: the Quest dies with its coded reason. A locked Hall is not one: its Quests park and resume on unlock. */
const PERMANENT: readonly BlockReason[] = ['hall_not_found', 'private_provider_unavailable']

/** Collaborators of {@link startRun}. */
export interface StartRunDeps {
  quests: Pick<QuestQueue, 'fail'>
  gates: Pick<GateStore, 'isBarred'>
  gateway: Pick<ModelGateway, 'openRun' | 'revokeRun'>
  mcp: Pick<McpGateway, 'lease'>
  sandboxes: Pick<SandboxRunner, 'start' | 'kill'>
  /** How long opening the run, leasing and starting the sandbox may take in all before the Quest is released (default 10s). */
  sandboxStartTimeoutMs?: number | undefined
  /** Told of a cleanup that failed after the Quest was given back; ids only, never content. */
  onError?: ((error: unknown, context: StartRunContext) => void) | undefined
}

/** The ids a {@link StartRunDeps.onError} report carries. */
export interface StartRunContext {
  guildId: string
  questId: string
  sandboxId: string
}

/** Why {@link startRun} did not leave a worker running. */
export type StartRunError =
  | 'gates_barred'
  | 'run_not_started'
  | 'sandbox_unavailable'
  | 'subscription_disabled'

/** How long {@link startRun} waits for the worker to come up when the deps do not say. */
const SANDBOX_START_TIMEOUT_MS = 10_000

/** What the bounded part of {@link startRun} (open the run, lease, start the sandbox) ended in. */
type Launch =
  | { kind: 'started' }
  | { kind: 'refused'; error: StartRunError }
  | { kind: 'provider_error'; cause: unknown }
  | { kind: 'sandbox_failed' }

/** Opens the run, leases the MCP session and starts the sandbox; never throws. */
async function launch(
  deps: StartRunDeps,
  guildId: string,
  claimed: Quest,
  profileId: string,
  sandboxId: string,
  deadline: { passed: boolean }
): Promise<Launch> {
  let run: Awaited<ReturnType<typeof openRun>>
  try {
    run = await openRun(deps, guildId, claimed, profileId)
  } catch (cause) {
    return { kind: 'provider_error', cause }
  }
  if (deadline.passed) {
    // The deadline's revoke found no row, so a run that settled late holds a live token: end it now.
    // Best effort only; cleanUp, which runs once this launch settles, is the backstop that
    // guarantees the final revoke and reports its failure.
    try {
      await deps.gateway.revokeRun(guildId, runIdFor(claimed.id, claimed.attempts))
    } catch {
      // Reported by cleanUp's own revoke.
    }
    return { kind: 'sandbox_failed' }
  }
  if (!('token' in run)) {
    return { kind: 'refused', error: run.error }
  }
  try {
    await deps.sandboxes.start(guildId, {
      questId: claimed.id,
      sandboxId,
      runToken: run.token,
      leaseHandle: JSON.stringify(await deps.mcp.lease(guildId, claimed)),
      doneCondition: claimed.doneCondition,
    })
  } catch {
    return { kind: 'sandbox_failed' }
  }
  return { kind: 'started' }
}

/**
 * Starts the worker of a Quest this caller has just claimed: opens its run, leases the MCP
 * session, starts the sandbox, and re-checks the bar once the container is up. On any refusal the
 * Quest is failed with a coded reason so it never keeps a live lease no worker will use. Opening,
 * leasing and starting share one deadline: on timeout the Quest is released as `timeout`, the run
 * is revoked (its token is dead), and whatever the stuck call finally does is undone by sandbox
 * id (the caller names the sandbox up front, so even a start that fails after creating its
 * container is stopped). Shared by Summon and the dispatcher. A throw from the run gateway fails
 * the Quest and is rethrown.
 */
export async function startRun(
  deps: StartRunDeps,
  guildId: string,
  claimed: Quest,
  profileId: string
): Promise<{ ok: true } | { ok: false; error: StartRunError }> {
  const release = (reason: string) =>
    deps.quests.fail(guildId, claimed.id, claimed.attempts, reason)
  const sandboxId = `gh-sbx-${crypto.randomUUID()}`
  const context: StartRunContext = { guildId, questId: claimed.id, sandboxId }
  const report = (error: unknown) => deps.onError?.(error, context)
  const cleanUp = async () => {
    try {
      await deps.gateway.revokeRun(guildId, runIdFor(claimed.id, claimed.attempts))
    } catch (error) {
      report(error)
    }
    try {
      await deps.sandboxes.kill({ guildId, questId: claimed.id, sandboxId })
    } catch (error) {
      report(error)
    }
  }
  const deadline = { passed: false }
  const launching = launch(deps, guildId, claimed, profileId, sandboxId, deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  const expired = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(
      () => resolve('timeout'),
      deps.sandboxStartTimeoutMs ?? SANDBOX_START_TIMEOUT_MS
    )
  })
  let outcome: Launch | 'timeout'
  try {
    outcome = await Promise.race([launching, expired])
  } finally {
    clearTimeout(timer)
  }
  if (outcome === 'timeout') {
    deadline.passed = true
    // Revoke first so a late container holds no live token, then give the Quest back.
    try {
      await deps.gateway.revokeRun(guildId, runIdFor(claimed.id, claimed.attempts))
    } catch (error) {
      report(error)
    }
    await release('timeout')
    // Whatever the stuck call ends in, the lease is gone: stop its container and discard it.
    void launching.then(cleanUp)
    return { ok: false, error: 'sandbox_unavailable' }
  }
  switch (outcome.kind) {
    case 'provider_error':
      await release('provider_error')
      throw outcome.cause
    case 'refused':
      await release('routing_blocked')
      return { ok: false, error: outcome.error }
    case 'sandbox_failed':
      // A start that failed may still have created its container.
      await cleanUp()
      await release('sandbox_unavailable')
      return { ok: false, error: 'sandbox_unavailable' }
    case 'started':
      break
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
    gateway: Pick<ModelGateway, 'revokeHallRuns'>
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
 * Pauses the work of the locked Halls. It reads the guild's active Quests once and does nothing
 * unless one sits in a locked Hall. Then the authoritative stops come first: the Hall's live runs
 * lose their model tokens and their leases go back to the queue (no attempt spent). Killing the
 * sandboxes is best effort after that: a kill that fails is reported by ids and never stops the
 * guild. Idempotent.
 */
async function parkLockedHalls(
  deps: Pick<DispatchDeps, 'quests' | 'gateway' | 'sandboxes' | 'onError'>,
  guildId: string,
  halls: readonly string[]
): Promise<void> {
  if (halls.length === 0) {
    return
  }
  const live: Quest[] = []
  let after: string | undefined
  do {
    const page = await deps.quests.list(guildId, {
      limit: MAX_QUEST_PAGE,
      state: 'active',
      ...(after === undefined ? {} : { after }),
    })
    live.push(...page.quests.filter((x) => halls.includes(x.hallId)))
    after = page.next ?? undefined
  } while (after !== undefined)
  if (live.length === 0) {
    return
  }
  for (const hall of new Set(live.map((q) => q.hallId))) {
    await deps.gateway.revokeHallRuns(guildId, hall)
  }
  await deps.quests.releaseLeases(guildId, 'routing_blocked', halls)
  for (const q of live) {
    try {
      await deps.sandboxes.kill({ guildId, questId: q.id })
    } catch (error) {
      // A kill is by Quest, so there is no sandbox id to name.
      deps.onError?.(error, { guildId, questId: q.id, sandboxId: '' })
    }
  }
}

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
  // A locked Hall pauses its work: live leases go back to the queue and its Quests are not claimed.
  await parkLockedHalls(deps, guildId, lockedHallIds(config))
  const claimed = await deps.quests.claim(guildId, {
    leaseMs: DISPATCH_LEASE_MS,
    ...claimLimits(config),
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

/** How many guilds one sweep dispatches at once, so a guild stuck on a slow call holds back at most itself. */
const SWEEP_CONCURRENCY = 4

/**
 * The job hook: one dispatch pass for each guild given, a few at a time (keeping no cron state:
 * the caller supplies the guilds and the schedule). A failing or slow guild does not stop the
 * rest; its error is returned beside the outcomes, in the order of `guildIds`.
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
  let next = 0
  const worker = async () => {
    while (next < guildIds.length) {
      const index = next
      next += 1
      const guildId = guildIds[index] ?? ''
      try {
        results[index] = { guildId, outcome: await dispatcher.dispatch(guildId) }
      } catch (error) {
        results[index] = { guildId, error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(SWEEP_CONCURRENCY, guildIds.length) }, worker))
  return results
}
