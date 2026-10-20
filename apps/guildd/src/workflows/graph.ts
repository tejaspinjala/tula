import { z } from 'zod'

/** Most nodes one workflow graph may hold (bounds the document and path analysis). */
export const MAX_NODES = 50
/** Most edges one workflow graph may hold. */
export const MAX_EDGES = 200

const nodeId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const label = z.string().trim().min(1).max(200).optional()

const triggerManual = z.object({ id: nodeId, type: z.literal('trigger.manual'), name: label })
const triggerSchedule = z.object({
  id: nodeId,
  type: z.literal('trigger.schedule'),
  name: label,
  /** Id of a schedule in the guild config (the existing schedules are reused, not redefined). */
  scheduleId: nodeId,
})
const agent = z.object({
  id: nodeId,
  type: z.literal('agent'),
  name: label,
  hallId: z.string().min(1).max(64),
  templateId: z.string().min(1).max(64),
  /** Brief text; `{{nodes.<id>.output}}` references the output of an upstream agent node. */
  briefTemplate: z.string().trim().min(1).max(4000),
  doneCondition: z.string().trim().min(1).max(2000),
  /**
   * The most this step may spend, in dollars. Advisory: it is summed across the graph against the
   * guild's daily spend cap at save time, but not enforced per Quest (the queue has no per-Quest
   * budget); the daily caps and Treasury still bound real spend.
   */
  maxUsd: z.number().min(0).max(100_000),
})
const subagents = z.object({
  id: nodeId,
  type: z.literal('subagents'),
  name: label,
  hallId: z.string().min(1).max(64),
  /** The Quest template of the coordinating Quest and of every Sub-Quest it spawns. */
  templateId: z.string().min(1).max(64),
  /** One brief per Sub-Quest; the coordinating Quest spawns one for each (at most `maxChildrenPerQuest`). */
  briefs: z.array(z.string().trim().min(1).max(500)).min(1).max(20),
  /** The fan-in: wait for `all` the Sub-Quests, or for the first one done (`any`). */
  join: z.enum(['all', 'any']),
  /** Advisory spend for the whole fan-out, summed against the daily spend cap at save time. */
  maxUsd: z.number().min(0).max(100_000),
})
const team = z.object({
  id: nodeId,
  type: z.literal('team'),
  name: label,
  hallId: z.string().min(1).max(64),
  /** The goal the Hall's Captain plans the Campaign for. */
  goal: z.string().trim().min(1).max(1500),
  /** The most Members that may work the Campaign at once (checked against the Hall's `maxConcurrentMembers`). */
  maxMembers: z.number().int().min(1).max(1000),
  /** The most Quests the Captain may post (checked against `maxQuestsPerCampaign`). */
  maxQuests: z.number().int().min(1).max(100),
  /** Advisory spend for the whole Campaign, summed against the daily spend cap at save time. */
  maxUsd: z.number().min(0).max(100_000),
})
const verify = z.object({
  id: nodeId,
  type: z.literal('verify'),
  name: label,
  /** The agent node whose Proposal the Verdict judges. */
  of: nodeId,
})
const approval = z.object({
  id: nodeId,
  type: z.literal('approval'),
  name: label,
  /** The verify node whose Proposal hash the Seal is bound to. */
  of: nodeId,
})
const post = z.object({
  id: nodeId,
  type: z.literal('post'),
  name: label,
  /** The approval node whose Seal publishes (manual publish through the existing Seal). */
  of: nodeId,
})

/** One node of a workflow graph. */
export const workflowNode = z.discriminatedUnion('type', [
  triggerManual,
  triggerSchedule,
  agent,
  subagents,
  team,
  verify,
  approval,
  post,
])
/** One node of a workflow graph. */
export type WorkflowNode = z.infer<typeof workflowNode>

/** A directed edge: `to` runs after `from`. */
export const workflowEdge = z.object({ from: nodeId, to: nodeId })

/** A workflow graph: nodes and the edges between them. */
export const workflowGraph = z.object({
  nodes: z.array(workflowNode).min(1).max(MAX_NODES),
  edges: z.array(workflowEdge).max(MAX_EDGES),
})
/** A workflow graph. */
export type WorkflowGraph = z.infer<typeof workflowGraph>

/** The workflow id: a slug, unique per guild. */
export const workflowId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)

/** One coded validation error, tied to a node when it concerns one. */
export interface WorkflowError {
  code: string
  nodeId?: string
  message: string
}
