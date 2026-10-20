import type { WorkflowNode } from './graph'

/** The most characters a Quest's done condition may hold (the queue's own limit). */
export const MAX_DONE_CONDITION = 2000

/**
 * The done condition of a `subagents` node's coordinating Quest: the instructions its Member runs
 * with the existing `spawn_subquest` and `await_children` tools. Pure and shared with the
 * validator, so a node whose briefs would not fit is refused at save time.
 */
export function subagentsDoneCondition(node: Extract<WorkflowNode, { type: 'subagents' }>): string {
  const briefs = node.briefs.map((brief, i) => `${i + 1}. ${brief}`).join('\n')
  return [
    `Spawn one Sub-Quest per brief below with spawn_subquest (Hall ${node.hallId}, template ${node.templateId}), then call await_children with mode ${node.join}.`,
    "Finish with the Sub-Quests' result refs.",
    briefs,
  ].join('\n')
}

/** The Campaign id of a `team` node in one instance: the instance id and the node's position (stable per version, within the queue's 100 characters). */
export function teamCampaignId(instanceId: string, nodeIndex: number): string {
  return `${instanceId}:${nodeIndex}`
}
