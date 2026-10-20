import { startRun } from './dispatch'
import { questConcurrency } from './guild-config'
import type { McpGateway } from './mcp/gateway'
import type { ModelGateway } from './model-gateway'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { GateStore } from './ports/gate-store'
import { hasLiveLease, QuestError, type QuestQueue } from './ports/quest-queue'
import type { SandboxRunner } from './ports/sandbox-runner'
import type { TripwireStore } from './ports/tripwire-store'
import { type PostQuestError, postQuest } from './quests'

/** The Quest template the Summon test Quest is posted from; its done-condition needs no Seal. */
export const SUMMON_TEMPLATE_ID = 'herald-brief'

/** The job key of the one test Quest of a guild's "Summon your first member" check. */
export const SUMMON_JOB_KEY = 'summon:first-member'

/** Why summoning could not start. */
export type SummonError =
  | PostQuestError
  | 'unknown_profile'
  | 'subscription_unsupported_until_spike_15'
  | 'gates_barred'
  | 'run_not_started'
  | 'sandbox_unavailable'

/** One step of the check. */
export interface SummonStep {
  id: 'provider' | 'test_quest'
  done: boolean
}

/** Where the check stands: complete only once the test Quest has passed on the real worker. */
export interface SummonStatus {
  complete: boolean
  steps: SummonStep[]
  /** The test Quest, once posted. */
  quest: { id: string; state: string } | null
}

/** The outcome of {@link Summon.start}. */
export type SummonStart = { ok: true; status: SummonStatus } | { ok: false; error: SummonError }

/** How long the test Quest's lease lasts: the worker's whole run. */
const LEASE_MS = 10 * 60_000

/** Collaborators of {@link Summon}. */
export interface SummonDeps {
  config: ConfigStore
  quests: QuestQueue
  tripwires: TripwireStore
  gates: Pick<GateStore, 'isBarred'>
  gateway: Pick<ModelGateway, 'openRun' | 'runRevoked'>
  mcp: Pick<McpGateway, 'lease'>
  sandboxes: Pick<SandboxRunner, 'start' | 'kill'>
  clock: Clock
  /** Whether the host has enabled `subscription` providers; they are refused otherwise. */
  subscriptionEnabled?: boolean
}

/**
 * "Summon your first member": posts one test Quest, runs it on the sandboxed worker with the
 * chosen provider's profile, and reports complete only when that Quest is done. Deterministic
 * code throughout; no model decides whether the check passed.
 */
export class Summon {
  constructor(private readonly deps: SummonDeps) {}

  /** Where the guild's check stands. */
  async status(guildId: string): Promise<SummonStatus> {
    const { config } = await this.deps.config.current(guildId)
    const apiKeyProviders = new Set(
      config.providers.filter((p) => p.auth === 'api_key').map((p) => p.id)
    )
    const provider = config.routingProfiles.some((p) => apiKeyProviders.has(p.provider))
    const quest = await this.deps.quests.findByJobKey(guildId, SUMMON_JOB_KEY)
    const passed = quest?.state === 'done'
    return {
      complete: provider && passed,
      steps: [
        { id: 'provider', done: provider },
        { id: 'test_quest', done: passed },
      ],
      quest: quest ? { id: quest.id, state: quest.state } : null,
    }
  }

  /** Posts the test Quest (once), leases it, opens its run and starts the worker. Idempotent. */
  async start(guildId: string, profileId: string): Promise<SummonStart> {
    if (await this.deps.gates.isBarred(guildId)) {
      return { ok: false, error: 'gates_barred' }
    }
    const { config } = await this.deps.config.current(guildId)
    const profile = config.routingProfiles.find((p) => p.id === profileId)
    const provider = profile && config.providers.find((p) => p.id === profile.provider)
    if (!profile || !provider) {
      return { ok: false, error: 'unknown_profile' }
    }
    if (provider.auth === 'subscription' && !this.deps.subscriptionEnabled) {
      return { ok: false, error: 'subscription_unsupported_until_spike_15' }
    }
    const posted = await postQuest(
      { config: this.deps.config, queue: this.deps.quests, tripwires: this.deps.tripwires },
      guildId,
      {
        templateId: SUMMON_TEMPLATE_ID,
        jobKey: SUMMON_JOB_KEY,
        title: 'Summon your first member: test Quest',
      }
    )
    if (!posted.ok) {
      return { ok: false, error: posted.error }
    }
    if (posted.quest.state === 'done') {
      return { ok: true, status: await this.status(guildId) }
    }
    if (hasLiveLease(posted.quest, this.deps.clock.now())) {
      // A lease whose run was revoked (a bar, a Hall pause) has no worker behind it: free it and start again.
      if (!(await this.deps.gateway.runRevoked(guildId, posted.quest.id, posted.quest.attempts))) {
        return { ok: true, status: await this.status(guildId) }
      }
      await this.deps.quests.releaseLeases(guildId, 'routing_blocked')
    }
    let claimed: Awaited<ReturnType<QuestQueue['claim']>>
    try {
      claimed = await this.deps.quests.claim(guildId, {
        leaseMs: LEASE_MS,
        maxActive: questConcurrency(config),
        questId: posted.quest.id,
      })
    } catch (error) {
      if (error instanceof QuestError && error.code === 'already_claimed') {
        return { ok: true, status: await this.status(guildId) }
      }
      throw error
    }
    if (claimed === null) {
      return { ok: false, error: 'run_not_started' }
    }
    const started = await startRun(this.deps, guildId, claimed, profileId)
    if (!started.ok) {
      return { ok: false, error: started.error }
    }
    return { ok: true, status: await this.status(guildId) }
  }
}
