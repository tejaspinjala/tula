import type { McpGateway } from './mcp/gateway'
import type { ModelGateway } from './model-gateway'
import type { Clock } from './ports/clock'
import type { ConfigStore } from './ports/config-store'
import type { QuestQueue } from './ports/quest-queue'
import type { SandboxRunner } from './ports/sandbox-runner'
import type { TripwireStore } from './ports/tripwire-store'
import type { PostQuestError } from './quests'

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

/** Collaborators of {@link Summon}. */
export interface SummonDeps {
  config: ConfigStore
  quests: QuestQueue
  tripwires: TripwireStore
  gateway: Pick<ModelGateway, 'openRun'>
  mcp: Pick<McpGateway, 'lease'>
  sandboxes: Pick<SandboxRunner, 'start'>
  clock: Clock
}

/**
 * "Summon your first member": posts one test Quest, runs it on the sandboxed worker with the
 * chosen provider's profile, and reports complete only when that Quest is done. Deterministic
 * code throughout; no model decides whether the check passed.
 */
export class Summon {
  constructor(private readonly deps: SummonDeps) {}

  /** Where the guild's check stands. */
  async status(_guildId: string): Promise<SummonStatus> {
    throw new Error('not implemented')
  }

  /** Posts the test Quest (once), leases it, opens its run and starts the worker. Idempotent. */
  async start(_guildId: string, _profileId: string): Promise<SummonStart> {
    throw new Error('not implemented')
  }
}
