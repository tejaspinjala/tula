import { z } from 'zod'
import { type GuildConfig, isHallLocked } from './guild-config'
import { costMicros, MICROS_PER_CENT } from './model-cost'
import { ACTIVITY_WINDOW_MS, type ActivityLog } from './ports/activity-log'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { GateStore } from './ports/gate-store'
import type { ModelLedger, RunRecord, UsageGroup, UsagePage } from './ports/model-ledger'
import {
  type ModelProvider,
  ModelProviderError,
  type ModelResponse,
  modelRequest,
  ProviderSecret,
} from './ports/model-provider'
import { hasLiveLease, type Quest, type QuestQueue } from './ports/quest-queue'
import type { SecretStore } from './ports/secret-store'
import type { TripwireStore } from './ports/tripwire-store'

/** Why the gateway refused or could not serve a call. */
export type GatewayErrorCode =
  | 'invalid_token'
  | 'invalid_request'
  | 'duplicate_call'
  | 'token_expired'
  | 'token_revoked'
  | 'hall_paused'
  /** The Hall is locked in the current config. */
  | 'hall_locked'
  /** Bar the Gates is up for this guild (or all guilds). */
  | 'gates_barred'
  /** The bar could not be read mid-call, so the call was aborted (fail closed); the reservation stays charged. */
  | 'gates_unavailable'
  | 'cap_reached'
  | 'unknown_profile'
  | 'model_unconfigured'
  | 'price_unconfigured'
  | 'key_missing'
  | 'provider_failed'
  /** The Claude subscription's usage limit is reached; the call is not retried. */
  | 'subscription_limit'
  /** Subscription providers are refused unless the host enables them (`SUBSCRIPTION_PROVIDER`). */
  | 'subscription_disabled'
  /** The classifier's provider is not private-eligible, so it receives no text. */
  | 'provider_not_private'

/** Thrown by the gateway; the code is the whole message, so no secret can ride in it. */
export class GatewayError extends Error {
  constructor(readonly code: GatewayErrorCode) {
    super(code)
    this.name = 'GatewayError'
  }
}

/** Which daily cap stopped work. */
export type CapReason = 'daily_tokens' | 'daily_spend'

/** The outcome of asking to start a run. */
export type OpenRunResult =
  | { status: 'started'; token: string; expiresAt: string }
  | { status: 'queued'; reason: CapReason }
  | { status: 'exists' }
  /** No token is issued: the Hall is paused (Tripwire or Guild Master), or the run was revoked for good. */
  | {
      status: 'refused'
      reason: 'hall_paused' | 'hall_locked' | 'quest_not_found' | 'token_revoked' | 'gates_barred'
    }

/** A queued run that the gateway admitted, with the token it now holds. */
export interface AdmittedRun {
  runId: string
  token: string
  expiresAt: string
}

/** A call as a worker makes it: no model id (the routing profile supplies it) and no key. */
export const gatewayCall = modelRequest.omit({ model: true }).extend({
  /**
   * Optional idempotency key, scoped to the run: a reuse is refused as `duplicate_call` before
   * any provider call. Metering never depends on it (the gateway mints its own call id).
   */
  idempotencyKey: z.string().min(1).max(200).optional(),
})
/** One call through the gateway. */
export type GatewayCall = z.input<typeof gatewayCall>

/** One Council voice's model call: the fixed system text and the framed brief, for one session. */
export interface CouncilCall {
  sessionId: string
  questId: string
  hallId: string
  system: string
  brief: string
}

/** A Council voice's reply with what it used. `costMicros` is null for a provider that bills no dollars. */
export interface CouncilReply {
  text: string
  usage: { inputTokens: number; outputTokens: number }
  costMicros: number | null
}

/** Collaborators of {@link ModelGateway}; adapters come from the composition root. */
export interface GatewayDeps {
  ledger: ModelLedger
  /** Only the internal `resolve` is used: the key never leaves the gateway. */
  secrets: Pick<SecretStore, 'resolve'>
  config: Pick<ConfigStore, 'current'>
  provider: ModelProvider
  /**
   * Serves `subscription` providers (the host's `claude` CLI). Absent when the deployment has not
   * enabled them, and then the gateway refuses every `subscription` profile.
   */
  subscriptionProvider?: ModelProvider
  clock: Clock
  /** Re-read on every open and call: a run token lives only while its Quest attempt holds a live lease. */
  quests: Pick<QuestQueue, 'get'>
  /** A paused Hall gets no new run and its live runs are refused. */
  tripwires: Pick<TripwireStore, 'isPaused'>
  /** Bar the Gates: read first on every open and call; a barred guild is refused before any work. */
  gates: Pick<GateStore, 'isBarred'>
  /** Records a model turn as a `member.activity` event (`thinking`). */
  activity: ActivityLog
  /** How long a run's token lives; defaults to 15 minutes. */
  tokenTtlMs?: number
  /** How often a call in flight re-reads the bar (durable, so no process state); defaults to 250 ms. */
  barPollMs?: number
}

const DEFAULT_BAR_POLL_MS = 250
/** A Council voice's call is aborted after this long (a vote is a short reply). */
export const COUNCIL_CALL_TIMEOUT_MS = 60_000
/** The most a Council voice may reply with: a vote and a few short reasons. */
const COUNCIL_MAX_REPLY_TOKENS = 600
const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000
const TOKEN_PREFIX = 'ghr'
const tokenShape = z.tuple([z.literal(TOKEN_PREFIX), z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)])

/**
 * An upper-bound estimate of a call's input tokens: the UTF-8 byte length of the input. It is an
 * upper bound because a byte-level tokenizer never produces more than one token per byte
 * (characters per token is not a safe bound: CJK text and emoji can cost a token or more per
 * character).
 */
function estimateInputTokens(call: {
  system?: string | undefined
  messages: Array<{ content: string }>
}): number {
  const encoder = new TextEncoder()
  return (
    encoder.encode(call.system ?? '').length +
    call.messages.reduce((n, m) => n + encoder.encode(m.content).length, 0)
  )
}

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

function newToken(guildId: string): string {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
  return `${TOKEN_PREFIX}.${guildId}.${secret}`
}

/** The id of the run for one Quest attempt: deterministic, so retries open the same run. */
export function runIdFor(questId: string, attempt: number): string {
  return `${questId}:${attempt}`
}

/** A routing profile resolved against its provider. */
interface Resolved {
  profile: GuildConfig['routingProfiles'][number]
  provider: GuildConfig['providers'][number]
}

function resolveProfile(
  config: GuildConfig,
  profileId: string,
  subscriptionEnabled: boolean
): Resolved {
  const profile = config.routingProfiles.find((p) => p.id === profileId)
  const provider = profile && config.providers.find((p) => p.id === profile.provider)
  if (!profile || !provider) {
    throw new GatewayError('unknown_profile')
  }
  if (provider.auth === 'subscription' && !subscriptionEnabled) {
    throw new GatewayError('subscription_disabled')
  }
  return { profile, provider }
}

/**
 * The model gateway: a Member's model calls go through here with a short-lived per-run token.
 * The gateway verifies the token (stored as a hash, scoped to one run, guild and Quest), takes
 * the model id and price from the routing profile in guild config, injects the real key from the
 * Vault, meters tokens and dollars per run, Quest, Hall and guild-day, and enforces the daily
 * caps. All of that is deterministic code; no model decides any of it.
 *
 * Caps are checked before every call and before a run starts, so a call in flight when the cap
 * is crossed completes and is metered (bounded overshoot), and the next one is refused. A new
 * run past a cap is queued, not failed, and the Steward notifies the Guild Master once per day.
 *
 * Prices come from the profile (open item O4: the spec has not fixed them), so a profile on an
 * `api_key` provider without a price is refused rather than metered as free.
 */
export class ModelGateway {
  private readonly ttlMs: number

  constructor(private readonly deps: GatewayDeps) {
    this.ttlMs = deps.tokenTtlMs ?? DEFAULT_TOKEN_TTL_MS
  }

  /**
   * Starts a run for one Quest attempt: issues its token, or queues it when a daily cap is hit.
   * The Quest must exist in this guild, be in the given Hall, active on that attempt with a live
   * lease (`quest_not_found` otherwise), and its Hall must not be paused. Idempotent per
   * Quest attempt: an active run reports `exists` (its token is shown only once); a queued run
   * is retried against the caps; a revoked run (a Hall pause revoked it) is reissued a fresh
   * token once the Hall is not paused, still bound to the live attempt and lease, but a cap
   * reports `exists` rather than queueing it.
   */
  async openRun(
    guildId: string,
    input: { questId: string; attempt: number; hallId: string; profileId: string }
  ): Promise<OpenRunResult> {
    if (await this.deps.gates.isBarred(guildId)) {
      return { status: 'refused', reason: 'gates_barred' }
    }
    const quest = await this.deps.quests.get(guildId, input.questId)
    if (
      !quest ||
      quest.hallId !== input.hallId ||
      quest.attempts !== input.attempt ||
      !hasLiveLease(quest, this.deps.clock.now())
    ) {
      return { status: 'refused', reason: 'quest_not_found' }
    }
    if (await this.deps.tripwires.isPaused(guildId, input.hallId)) {
      return { status: 'refused', reason: 'hall_paused' }
    }
    if (await this.hallLocked(guildId, input.hallId)) {
      return { status: 'refused', reason: 'hall_locked' }
    }
    const run = { ...input, runId: runIdFor(input.questId, input.attempt) }
    const existing = await this.deps.ledger.getRun(guildId, run.runId)
    if (existing?.state === 'active') {
      return { status: 'exists' }
    }
    if (existing?.state === 'revoked' && existing.revokeReason !== 'hall_paused') {
      return { status: 'refused', reason: 'token_revoked' }
    }
    const { config } = await this.deps.config.current(guildId)
    const { profile } = resolveProfile(
      config,
      run.profileId,
      this.deps.subscriptionProvider !== undefined
    )
    const capped = await this.capReason(guildId, config)
    const issue = this.issue(guildId)
    if (capped && existing?.state === 'revoked') {
      return { status: 'exists' }
    }
    if (capped) {
      await this.deps.ledger.openRun(guildId, {
        ...run,
        providerId: profile.provider,
        state: 'queued',
        tokenHash: null,
        expiresAt: null,
      })
      await this.notify(guildId, capped)
      return { status: 'queued', reason: capped }
    }
    const started = { status: 'started', token: issue.token, expiresAt: issue.expiresAt } as const
    if (existing) {
      // Only a queued or revoked run reaches here; activating it is atomic, so a racing retry
      // starts it once.
      return (await this.deps.ledger.activate(guildId, run.runId, issue.hash, issue.expiresAt))
        ? started
        : { status: 'exists' }
    }
    const created = await this.deps.ledger.openRun(guildId, {
      ...run,
      providerId: profile.provider,
      state: 'active',
      tokenHash: issue.hash,
      expiresAt: issue.expiresAt,
    })
    return created === 'created' ? started : { status: 'exists' }
  }

  /** Admits queued runs, oldest first, while the caps have room; returns the tokens issued. */
  async admitQueued(guildId: string, limit: number): Promise<AdmittedRun[]> {
    if (await this.deps.gates.isBarred(guildId)) {
      return []
    }
    const admitted: AdmittedRun[] = []
    for (const run of await this.deps.ledger.listQueued(guildId, limit)) {
      const { config } = await this.deps.config.current(guildId)
      if (await this.capReason(guildId, config)) {
        break
      }
      try {
        resolveProfile(config, run.profileId, this.deps.subscriptionProvider !== undefined)
      } catch (e) {
        if (e instanceof GatewayError) {
          continue
        }
        throw e
      }
      const issue = this.issue(guildId)
      if (await this.deps.ledger.activate(guildId, run.runId, issue.hash, issue.expiresAt)) {
        admitted.push({ runId: run.runId, token: issue.token, expiresAt: issue.expiresAt })
      }
    }
    return admitted
  }

  /** The cost table: spend grouped by run, Quest, Hall or day, ascending by key, paginated. */
  usage(
    guildId: string,
    by: UsageGroup,
    page: { after?: string; limit: number }
  ): Promise<UsagePage> {
    return this.deps.ledger.report(guildId, by, page)
  }

  /** Revokes every queued or active run of a Hall (its pause); returns how many. */
  revokeHallRuns(guildId: string, hallId: string): Promise<number> {
    return this.deps.ledger.revokeHallRuns(guildId, hallId)
  }

  /** Revokes every run token of the guild for good (Bar the Gates); returns how many. */
  revokeGuildRuns(guildId: string): Promise<number> {
    return this.deps.ledger.revokeGuildRuns(guildId)
  }

  /** Revokes every run token of every guild for good (a global Bar the Gates); returns how many. */
  revokeAllRuns(): Promise<number> {
    return this.deps.ledger.revokeAllRuns()
  }

  /** Revokes a run's token so its next call is refused; false if the run is unknown. */
  revokeRun(guildId: string, runId: string): Promise<boolean> {
    return this.deps.ledger.revoke(guildId, runId)
  }

  /**
   * Serves one call for the run holding `token`; throws {@link GatewayError}. The call's
   * estimated charge (input size plus `maxTokens` at the profile price) is reserved against the
   * daily caps atomically before the provider is called, and reconciled to actual usage after.
   * If the provider fails, replies without usable usage, or the reconcile fails, the estimate
   * stays as the charge: a call that may have been served is never free.
   */
  async complete(token: string, call: GatewayCall): Promise<ModelResponse> {
    const request = gatewayCall.safeParse(call)
    const guildId = this.guildOf(token)
    if (await this.deps.gates.isBarred(guildId)) {
      throw new GatewayError('gates_barred')
    }
    const run = await this.deps.ledger.findByTokenHash(guildId, sha256(token))
    if (!run) {
      throw new GatewayError('invalid_token')
    }
    this.checkLive(run)
    if (await this.deps.tripwires.isPaused(guildId, run.hallId)) {
      throw new GatewayError('hall_paused')
    }
    if (await this.hallLocked(guildId, run.hallId)) {
      throw new GatewayError('hall_locked')
    }
    const quest = await this.deps.quests.get(guildId, run.questId)
    if (!quest || quest.attempts !== run.attempt || !hasLiveLease(quest, this.deps.clock.now())) {
      throw new GatewayError('token_revoked')
    }
    if (!request.success) {
      throw new GatewayError('invalid_request')
    }
    return (await this.serve(guildId, run, request.data, quest)).response
  }

  /**
   * The metered part of a call, shared by a run's {@link ModelGateway.complete} and a Council
   * voice: resolves the profile, reserves the estimate against the daily caps, calls the provider
   * (aborted by Bar the Gates, and by `timeoutMs` when given) and reconciles to actual usage.
   */
  private async serve(
    guildId: string,
    run: { runId: string; profileId: string },
    data: z.output<typeof gatewayCall>,
    quest: Quest | null,
    timeoutMs?: number
  ): Promise<{ response: ModelResponse; costMicros: number | null }> {
    const { config } = await this.deps.config.current(guildId)
    const { profile, provider } = resolveProfile(
      config,
      run.profileId,
      this.deps.subscriptionProvider !== undefined
    )
    if (!profile.model) {
      throw new GatewayError('model_unconfigured')
    }
    if (provider.auth === 'api_key' && !profile.price) {
      throw new GatewayError('price_unconfigured')
    }
    const subscription = provider.auth === 'subscription'
    // A subscription's credential is the host's signed-in CLI: no Vault secret, no price.
    const key = subscription ? '' : await this.deps.secrets.resolve(guildId, provider.id)
    if (key === null) {
      throw new GatewayError('key_missing')
    }
    const price = subscription ? undefined : profile.price
    const backend =
      subscription && this.deps.subscriptionProvider
        ? this.deps.subscriptionProvider
        : this.deps.provider
    const { idempotencyKey, ...rest } = data
    const callKey = crypto.randomUUID()
    const estimate = {
      inputTokens: estimateInputTokens(rest),
      outputTokens: rest.maxTokens,
    }
    const day = this.day()
    const reserved = await this.deps.ledger.reserve(guildId, {
      callKey,
      runId: run.runId,
      day,
      ...estimate,
      costMicros: price ? costMicros(estimate, price) : null,
      clientKey: idempotencyKey ?? null,
      caps: {
        tokens: config.caps.dailyTokens,
        costMicros: config.caps.dailySpendCents * MICROS_PER_CENT,
      },
    })
    if (reserved.status === 'duplicate') {
      throw new GatewayError('duplicate_call')
    }
    if (reserved.status === 'cap_reached') {
      await this.notify(guildId, reserved.reason)
      throw new GatewayError('cap_reached')
    }
    if (quest) {
      await this.noteThinking(guildId, quest)
    }
    let response: ModelResponse
    // Bar the Gates mid-call: the bar is read from the store while the call is in flight, and
    // aborts it. The reservation stays as the charge (the failure path below never settles).
    // Fails closed: a bar check that errors aborts the call as `gates_unavailable`, since the bar
    // cannot be known. A tick is skipped while the previous check is still pending.
    const barred = new AbortController()
    const signal =
      timeoutMs === undefined
        ? barred.signal
        : AbortSignal.any([barred.signal, AbortSignal.timeout(timeoutMs)])
    let abortCode: 'gates_barred' | 'gates_unavailable' = 'gates_barred'
    let checking = false
    const poll = setInterval(() => {
      if (checking) {
        return
      }
      checking = true
      this.deps.gates
        .isBarred(guildId)
        .then(
          (yes) => {
            if (yes) {
              barred.abort()
            }
          },
          () => {
            abortCode = 'gates_unavailable'
            barred.abort()
          }
        )
        .finally(() => {
          checking = false
        })
    }, this.deps.barPollMs ?? DEFAULT_BAR_POLL_MS)
    try {
      response = await backend.complete(
        new ProviderSecret(key),
        { ...rest, model: profile.model },
        signal
      )
    } catch (e) {
      if (barred.signal.aborted) {
        throw new GatewayError(abortCode)
      }
      if (signal.aborted) {
        throw new GatewayError('provider_failed')
      }
      if (e instanceof ModelProviderError) {
        throw new GatewayError(
          e.code === 'subscription_limit' ? 'subscription_limit' : 'provider_failed'
        )
      }
      throw e
    } finally {
      clearInterval(poll)
    }
    try {
      await this.deps.ledger.settle(guildId, callKey, {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        costMicros: price ? costMicros(response.usage, price) : null,
      })
    } catch {
      // The estimate stays as the charge and the reply is still returned. Ids only: no error
      // text, no content and no secret can reach the log.
      process.stderr.write(
        `${JSON.stringify({ event: 'gateway.settle_failed', guildId, runId: run.runId, callKey })}\n`
      )
    }
    return { response, costMicros: price ? costMicros(response.usage, price) : null }
  }

  /**
   * One Council voice's model call, served from the guild's `mid` routing profile (the model id
   * and price come from config, never from here). The voices of a session share one ledger run,
   * `council:<session id>`, filed under the Proposal's Quest and Hall, so the usage is metered per
   * run, Quest, Hall and guild-day and counts against the daily caps like any other call. A call
   * is refused before the provider by Bar the Gates, a paused Hall or a reached cap; it is aborted
   * after {@link COUNCIL_CALL_TIMEOUT_MS}. The provider adapters retry transient failures with
   * jitter. Throws {@link GatewayError}.
   */
  async councilComplete(guildId: string, call: CouncilCall): Promise<CouncilReply> {
    if (await this.deps.gates.isBarred(guildId)) {
      throw new GatewayError('gates_barred')
    }
    if (await this.deps.tripwires.isPaused(guildId, call.hallId)) {
      throw new GatewayError('hall_paused')
    }
    if (await this.hallLocked(guildId, call.hallId)) {
      throw new GatewayError('hall_locked')
    }
    const { config } = await this.deps.config.current(guildId)
    const profile = config.routingProfiles.find((p) => p.tier === 'mid')
    if (!profile) {
      throw new GatewayError('unknown_profile')
    }
    const runId = `council:${call.sessionId}`
    const issue = this.issue(guildId)
    await this.deps.ledger.openRun(guildId, {
      runId,
      questId: call.questId,
      attempt: 1,
      hallId: call.hallId,
      providerId: profile.provider,
      profileId: profile.id,
      state: 'active',
      // The token is never handed out: a Council run has no holder that could call `complete`.
      tokenHash: issue.hash,
      expiresAt: issue.expiresAt,
    })
    const { response, costMicros } = await this.serve(
      guildId,
      { runId, profileId: profile.id },
      {
        system: call.system,
        messages: [{ role: 'user', content: call.brief }],
        maxTokens: COUNCIL_MAX_REPLY_TOKENS,
      },
      null,
      COUNCIL_CALL_TIMEOUT_MS
    )
    return { text: response.text, usage: response.usage, costMicros }
  }

  /** Stub. */
  async classifierComplete(
    _guildId: string,
    _call: { decisionKey: string; hallId: string; prompt: string; signal?: AbortSignal }
  ): Promise<string> {
    throw new GatewayError('unknown_profile')
  }

  /**
   * A model turn begins: records the Quest's Member as `thinking` (ids and the name only). A
   * failure to record is logged by ids and never fails the call.
   */
  private async noteThinking(guildId: string, quest: Quest): Promise<void> {
    try {
      await this.deps.activity.record(guildId, {
        questId: quest.id,
        memberId: quest.ownerId,
        hallId: quest.hallId,
        activity: 'thinking',
        at: this.deps.clock.now(),
        windowMs: ACTIVITY_WINDOW_MS,
      })
    } catch {
      process.stderr.write(
        `${JSON.stringify({ event: 'gateway.activity_failed', guildId, questId: quest.id })}\n`
      )
    }
  }

  /** Whether the run of this Quest attempt exists and has been revoked, so no worker can use its token. */
  async runRevoked(guildId: string, questId: string, attempt: number): Promise<boolean> {
    const run = await this.deps.ledger.getRun(guildId, runIdFor(questId, attempt))
    return run?.state === 'revoked'
  }

  /**
   * The guild of the run holding `token`, or null when the token is malformed or names no run.
   * Looked up by hash, so a forged token never yields a guild an abuse bucket could be keyed on.
   */
  async verifiedGuild(token: string): Promise<string | null> {
    const parts = tokenShape.safeParse(token.split('.'))
    if (!parts.success) {
      return null
    }
    const run = await this.deps.ledger.findByTokenHash(parts.data[1], sha256(token))
    return run ? parts.data[1] : null
  }

  private guildOf(token: string): string {
    const parts = tokenShape.safeParse(token.split('.'))
    if (!parts.success) {
      throw new GatewayError('invalid_token')
    }
    return parts.data[1]
  }

  private checkLive(run: RunRecord): void {
    if (run.state === 'revoked') {
      throw new GatewayError('token_revoked')
    }
    if (
      run.state !== 'active' ||
      run.expiresAt === null ||
      Date.parse(run.expiresAt) <= this.deps.clock.now().getTime()
    ) {
      throw new GatewayError(run.state === 'active' ? 'token_expired' : 'invalid_token')
    }
  }

  /** Whether the guild's current config has the Hall locked; every metered path checks it before the provider. */
  private async hallLocked(guildId: string, hallId: string): Promise<boolean> {
    return isHallLocked((await this.deps.config.current(guildId)).config, hallId)
  }

  private issue(guildId: string) {
    const token = newToken(guildId)
    return {
      token,
      hash: sha256(token),
      expiresAt: new Date(this.deps.clock.now().getTime() + this.ttlMs).toISOString(),
    }
  }

  /** The UTC guild-day the clock is in. */
  private day(): string {
    return this.deps.clock.now().toISOString().slice(0, 10)
  }

  private async capReason(guildId: string, config: GuildConfig): Promise<CapReason | null> {
    const totals = await this.deps.ledger.dayTotals(guildId, this.day())
    if (totals.tokens >= config.caps.dailyTokens) {
      return 'daily_tokens'
    }
    if (totals.costMicros >= config.caps.dailySpendCents * MICROS_PER_CENT) {
      return 'daily_spend'
    }
    return null
  }

  private async notify(guildId: string, reason: CapReason): Promise<void> {
    await this.deps.ledger.noteCapReached(guildId, this.day(), reason)
  }
}
