import { z } from 'zod'
import type { GuildConfig } from './guild-config'
import { costMicros, MICROS_PER_CENT } from './model-cost'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { ModelLedger, RunRecord, UsageGroup, UsagePage } from './ports/model-ledger'
import {
  type ModelProvider,
  ModelProviderError,
  type ModelResponse,
  modelRequest,
  ProviderSecret,
} from './ports/model-provider'
import type { SecretStore } from './ports/secret-store'

/** Why the gateway refused or could not serve a call. */
export type GatewayErrorCode =
  | 'invalid_token'
  | 'token_expired'
  | 'token_revoked'
  | 'cap_reached'
  | 'unknown_profile'
  | 'model_unconfigured'
  | 'price_unconfigured'
  | 'key_missing'
  | 'provider_failed'
  /** Subscription providers wait on spike #15; until then the gateway refuses them. */
  | 'subscription_unsupported_until_spike_15'

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

/** A queued run that the gateway admitted, with the token it now holds. */
export interface AdmittedRun {
  runId: string
  token: string
  expiresAt: string
}

/** A call as a worker makes it: no model id (the routing profile supplies it) and no key. */
export const gatewayCall = modelRequest.omit({ model: true }).extend({
  /** Idempotency key: the same key meters once. */
  callKey: z.string().min(1).max(200).optional(),
})
/** One call through the gateway. */
export type GatewayCall = z.input<typeof gatewayCall>

/** Collaborators of {@link ModelGateway}; adapters come from the composition root. */
export interface GatewayDeps {
  ledger: ModelLedger
  /** Only the internal `resolve` is used: the key never leaves the gateway. */
  secrets: Pick<SecretStore, 'resolve'>
  config: Pick<ConfigStore, 'current'>
  provider: ModelProvider
  clock: Clock
  /** How long a run's token lives; defaults to 15 minutes. */
  tokenTtlMs?: number
}

const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000
const TOKEN_PREFIX = 'ghr'
const tokenShape = z.tuple([z.literal(TOKEN_PREFIX), z.uuid(), z.string().regex(/^[0-9a-f]{64}$/)])

function sha256(value: string): string {
  return new Bun.CryptoHasher('sha256').update(value).digest('hex')
}

function newToken(guildId: string): string {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
  return `${TOKEN_PREFIX}.${guildId}.${secret}`
}

/** A routing profile resolved against its provider. */
interface Resolved {
  profile: GuildConfig['routingProfiles'][number]
  provider: GuildConfig['providers'][number]
}

function resolveProfile(config: GuildConfig, profileId: string): Resolved {
  const profile = config.routingProfiles.find((p) => p.id === profileId)
  const provider = profile && config.providers.find((p) => p.id === profile.provider)
  if (!profile || !provider) {
    throw new GatewayError('unknown_profile')
  }
  if (provider.auth === 'subscription') {
    throw new GatewayError('subscription_unsupported_until_spike_15')
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
   * Starts a run: issues its token, or queues it when a daily cap is hit. Idempotent per
   * `runId`: an active run reports `exists` (its token is shown only once); a queued run is
   * retried against the caps.
   */
  async openRun(
    guildId: string,
    run: { runId: string; questId: string; hallId: string; profileId: string }
  ): Promise<OpenRunResult> {
    const { config } = await this.deps.config.current(guildId)
    const { profile } = resolveProfile(config, run.profileId)
    const capped = await this.capReason(guildId, config)
    const issue = this.issue(guildId)
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
    const created = await this.deps.ledger.openRun(guildId, {
      ...run,
      providerId: profile.provider,
      state: 'active',
      tokenHash: issue.hash,
      expiresAt: issue.expiresAt,
    })
    if (created === 'created') {
      return { status: 'started', token: issue.token, expiresAt: issue.expiresAt }
    }
    const existing = await this.deps.ledger.getRun(guildId, run.runId)
    if (
      existing?.state === 'queued' &&
      (await this.deps.ledger.activate(guildId, run.runId, issue.hash, issue.expiresAt))
    ) {
      return { status: 'started', token: issue.token, expiresAt: issue.expiresAt }
    }
    return { status: 'exists' }
  }

  /** Admits queued runs, oldest first, while the caps have room; returns the tokens issued. */
  async admitQueued(guildId: string, limit: number): Promise<AdmittedRun[]> {
    const admitted: AdmittedRun[] = []
    for (const run of await this.deps.ledger.listQueued(guildId, limit)) {
      const { config } = await this.deps.config.current(guildId)
      if (await this.capReason(guildId, config)) {
        break
      }
      try {
        resolveProfile(config, run.profileId)
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

  /** Revokes a run's token so its next call is refused; false if the run is unknown. */
  revokeRun(guildId: string, runId: string): Promise<boolean> {
    return this.deps.ledger.revoke(guildId, runId)
  }

  /** Serves one call for the run holding `token`; throws {@link GatewayError}. */
  async complete(token: string, call: GatewayCall): Promise<ModelResponse> {
    const request = gatewayCall.safeParse(call)
    const guildId = this.guildOf(token)
    const run = await this.deps.ledger.findByTokenHash(guildId, sha256(token))
    if (!run) {
      throw new GatewayError('invalid_token')
    }
    this.checkLive(run)
    if (!request.success) {
      throw new GatewayError('provider_failed')
    }
    const { config } = await this.deps.config.current(guildId)
    const { profile, provider } = resolveProfile(config, run.profileId)
    const capped = await this.capReason(guildId, config)
    if (capped) {
      await this.notify(guildId, capped)
      throw new GatewayError('cap_reached')
    }
    if (!profile.model) {
      throw new GatewayError('model_unconfigured')
    }
    if (provider.auth === 'api_key' && !profile.price) {
      throw new GatewayError('price_unconfigured')
    }
    const key = await this.deps.secrets.resolve(guildId, provider.id)
    if (key === null) {
      throw new GatewayError('key_missing')
    }
    const { callKey, ...rest } = request.data
    let response: ModelResponse
    try {
      response = await this.deps.provider.complete(new ProviderSecret(key), {
        ...rest,
        model: profile.model,
      })
    } catch (e) {
      if (e instanceof ModelProviderError) {
        throw new GatewayError('provider_failed')
      }
      throw e
    }
    await this.deps.ledger.recordUsage(guildId, {
      callKey: callKey ?? crypto.randomUUID(),
      runId: run.runId,
      day: this.day(),
      inputTokens: response.usage.inputTokens,
      outputTokens: response.usage.outputTokens,
      costMicros: profile.price ? costMicros(response.usage, profile.price) : null,
    })
    return response
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
