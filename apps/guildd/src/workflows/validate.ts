import type { GuildConfig } from '../guild-config'
import { QUEST_TEMPLATES, type QuestTemplate } from '../quests'
import type { WorkflowError } from './graph'

/**
 * Deterministic save-time validation of a workflow graph (SPEC 27.3 subset): schema, graph shape,
 * references, the gate rule and the budget. Returns every error found; empty means valid.
 */
export function validateWorkflow(
  _input: unknown,
  _config: GuildConfig,
  _templates: readonly QuestTemplate[] = QUEST_TEMPLATES
): WorkflowError[] {
  return [{ code: 'not_implemented', message: 'stub' }]
}
