import { z } from 'zod'

/** Most nodes one rite graph may hold (bounds the document and path analysis). */
export const MAX_NODES = 50
/** Most edges one rite graph may hold. */
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
  /** A ceiling, not a per-run limit: checked against the Hall's `maxConcurrentMembers` when saved. The Hall cap enforces the real limit. */
  maxMembers: z.number().int().min(1).max(1000),
  /** A ceiling, not a per-run limit: checked against `maxQuestsPerCampaign` when saved. The guild cap enforces the real limit. */
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

/** One node of a rite graph. */
export const riteNode = z.discriminatedUnion('type', [
  triggerManual,
  triggerSchedule,
  agent,
  subagents,
  team,
  verify,
  approval,
  post,
])
/** One node of a rite graph. */
export type RiteNode = z.infer<typeof riteNode>

/** A directed edge: `to` runs after `from`. */
export const riteEdge = z.object({ from: nodeId, to: nodeId })

/** A rite graph: nodes and the edges between them. */
export const riteGraph = z.object({
  nodes: z.array(riteNode).min(1).max(MAX_NODES),
  edges: z.array(riteEdge).max(MAX_EDGES),
})
/** A rite graph. */
export type RiteGraph = z.infer<typeof riteGraph>

/** The rite id: a slug, unique per guild. */
export const riteId = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)

/** One coded validation error, tied to a node when it concerns one. */
export interface RiteError {
  code: string
  nodeId?: string
  message: string
}
