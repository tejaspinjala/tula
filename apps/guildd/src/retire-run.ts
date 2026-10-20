import { type ModelGateway, runIdFor } from './model-gateway'
import type { SandboxRunner } from './ports/sandbox-runner'

/** What {@link retireRun} stops a run with. */
export interface RetireRunDeps {
  runs: Pick<ModelGateway, 'revokeRun'>
  sandboxes: Pick<SandboxRunner, 'kill'>
}

/**
 * Ends one delivery's run for good: revokes its model token (final, not reissuable) and kills its
 * sandbox. Used when a Quest parks on its Sub-Quests, so the parent cannot keep calling the model
 * outside the worker-slot count. Idempotent; deterministic code, no model decision.
 */
export function retireRun(
  deps: RetireRunDeps
): (guildId: string, questId: string, attempt: number) => Promise<void> {
  return async (guildId, questId, attempt) => {
    await deps.runs.revokeRun(guildId, runIdFor(questId, attempt))
    await deps.sandboxes.kill({ guildId, questId })
  }
}
