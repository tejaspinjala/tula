import type { ConfigStore } from '../ports/config-store'
import type { HandoffStore } from '../ports/handoff-store'
import type { Quest, QuestQueue } from '../ports/quest-queue'
import type { SealStore } from '../ports/seal-store'
import type { TripwireStore } from '../ports/tripwire-store'
import type {
  WorkflowInstance,
  WorkflowInstancePage,
  WorkflowPage,
  WorkflowStore,
  WorkflowVersion,
  WorkflowVersionPage,
} from '../ports/workflow-store'
import type { ProposalEngine } from '../proposals'
import { type PostQuestError, postQuest } from '../quests'
import { type StartTeamCampaignError, startTeamCampaign } from '../team-campaign'
import { classifyWorkflowChange } from './classify'
import { subagentsDoneCondition, teamCampaignId } from './fanout'
import { type WorkflowError, type WorkflowGraph, type WorkflowNode, workflowGraph } from './graph'
import { LEARNING_TO_LINKEDIN, LEARNING_TO_LINKEDIN_ID } from './templates'
import { validateWorkflow } from './validate'

/** Collaborators of {@link WorkflowEngine}. The engine holds no authority of its own. */
export interface WorkflowEngineDeps {
  store: WorkflowStore
  config: ConfigStore
  quests: QuestQueue
  tripwires: TripwireStore
  proposals: Pick<ProposalEngine, 'latestForQuest' | 'verdictFor'>
  seals: Pick<SealStore, 'forQuest'>
  /** Reads the Handoffs whose artifacts are a `subagents` or `team` node's result refs. */
  handoffs: Pick<HandoffStore, 'get'>
}

/** The outcome of {@link WorkflowEngine.save}. */
export type SaveResult =
  | { status: 'invalid'; errors: WorkflowError[] }
  | { status: 'active' | 'pending'; version: WorkflowVersion }

/** Why a run could not start or finish compiling. */
export type RunError =
  | 'not_found'
  | 'no_active_version'
  | 'version_not_active'
  | 'no_manual_trigger'
  | 'invalid_workflow'
  | PostQuestError
  | StartTeamCampaignError

/** The outcome of {@link WorkflowEngine.run}. */
export type RunResult =
  | {
      ok: true
      instance: WorkflowInstance
      created: boolean
      quests: { nodeId: string; questId: string }[]
    }
  | { ok: false; error: RunError; nodeId?: string; errors?: WorkflowError[]; runKey?: string }

/** One node's status in a run. */
export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_seal'
  | 'done'
  | 'failed'
  | 'passed'
  | 'awaiting'
  | 'approved'
  | 'rejected'
  | 'publishing'

/** The state of one instance: its nodes and their statuses. */
export interface RunState {
  instance: WorkflowInstance
  nodes: {
    id: string
    type: string
    status: NodeStatus
    questId: string | null
    /** A `subagents` or `team` node's output: the artifact hashes its finished Quests produced. */
    refs: string[]
  }[]
}

const AGENT_STATUS = {
  queued: 'queued',
  active: 'running',
  awaiting_seal: 'awaiting_seal',
  done: 'done',
  dead: 'failed',
} as const

type QuestNode = Extract<WorkflowNode, { type: 'agent' | 'subagents' | 'team' }>

const startsQuests = (n: WorkflowNode): n is QuestNode =>
  n.type === 'agent' || n.type === 'subagents' || n.type === 'team'

/** The Quest-starting nodes that run directly before `id`, looking back through gate nodes. */
function upstreamAgents(graph: WorkflowGraph, id: string): string[] {
  const starters = new Set(graph.nodes.filter(startsQuests).map((n) => n.id))
  const found = new Set<string>()
  const seen = new Set<string>()
  const stack = [id]
  while (stack.length > 0) {
    const at = stack.pop()
    if (at === undefined) {
      break
    }
    for (const e of graph.edges.filter((x) => x.to === at)) {
      if (seen.has(e.from)) {
        continue
      }
      seen.add(e.from)
      if (starters.has(e.from)) {
        found.add(e.from)
      } else {
        stack.push(e.from)
      }
    }
  }
  return graph.nodes.filter((n) => found.has(n.id)).map((n) => n.id)
}

/** Quest-starting nodes in an order where every upstream one comes first (stable by graph order). */
function agentOrder(graph: WorkflowGraph): QuestNode[] {
  const agents = graph.nodes.filter(startsQuests)
  const done = new Set<string>()
  const ordered: QuestNode[] = []
  while (ordered.length < agents.length) {
    const next = agents.find(
      (a) => !done.has(a.id) && upstreamAgents(graph, a.id).every((u) => done.has(u))
    )
    if (!next) {
      break
    }
    done.add(next.id)
    ordered.push(next)
  }
  return ordered
}

/** The idempotency key of a node execution: `instance:node:iteration` (one iteration here). */
const jobKey = (instanceId: string, nodeId: string) => `${instanceId}:${nodeId}:0`

/** The job key {@link startTeamCampaign} posts a `team` node's plan Quest under. */
const teamJobKey = (instanceId: string, nodeIndex: number) =>
  `team:${teamCampaignId(instanceId, nodeIndex)}`

/**
 * The workflow engine: validates and versions graphs, and compiles an instance's `agent` nodes to
 * Quests through the normal queue. It has no authority of its own: Verdicts, Seals, caps and the
 * bar are enforced by the same code paths as for any Quest.
 */
export class WorkflowEngine {
  constructor(private readonly deps: WorkflowEngineDeps) {}

  /** Dry-run validation against the guild's current config. */
  async validate(guildId: string, graph: unknown): Promise<WorkflowError[]> {
    const { config } = await this.deps.config.current(guildId)
    return validateWorkflow(graph, config)
  }

  /**
   * Saves the next version: invalid graphs are refused with coded errors; a save that is not
   * provably no wider than the previous version (or any first version) is stored `pending` and
   * runs only once confirmed.
   */
  async save(
    guildId: string,
    workflowId: string,
    input: { name: string; graph: unknown }
  ): Promise<SaveResult> {
    const errors = await this.validate(guildId, input.graph)
    if (errors.length > 0) {
      return { status: 'invalid', errors }
    }
    const graph = workflowGraph.parse(input.graph)
    const previous = await this.deps.store.latestActive(guildId, workflowId)
    const classification = classifyWorkflowChange(previous?.graph ?? null, graph)
    const status = classification === 'internal' ? 'active' : 'pending'
    const version = await this.deps.store.saveVersion(guildId, workflowId, {
      name: input.name,
      graph,
      classification,
      status,
    })
    return { status, version }
  }

  /** Confirms a pending version (the caller has re-authenticated); null when absent. */
  async confirm(
    guildId: string,
    workflowId: string,
    version: number
  ): Promise<WorkflowVersion | null> {
    return this.deps.store.activate(guildId, workflowId, version)
  }

  /** Workflows in id order after `after`. */
  list(guildId: string, page: { after?: string; limit: number }): Promise<WorkflowPage> {
    return this.deps.store.list(guildId, page)
  }

  /** A version (the latest of any status when `version` is omitted) and the newest runnable one. */
  async get(
    guildId: string,
    workflowId: string,
    version?: number
  ): Promise<{ version: WorkflowVersion; activeVersion: number | null } | null> {
    const found = await this.deps.store.getVersion(guildId, workflowId, version)
    if (!found) {
      return null
    }
    const active = await this.deps.store.latestActive(guildId, workflowId)
    return { version: found, activeVersion: active?.version ?? null }
  }

  /** Versions newest first, below `before`. */
  versions(
    guildId: string,
    workflowId: string,
    page: { before?: number; limit: number }
  ): Promise<WorkflowVersionPage> {
    return this.deps.store.versions(guildId, workflowId, page)
  }

  /** Instances of a Workflow in id order after `after`. */
  runs(
    guildId: string,
    workflowId: string,
    page: { after?: string; limit: number }
  ): Promise<WorkflowInstancePage> {
    return this.deps.store.listInstances(guildId, workflowId, page)
  }

  /** Saves the seeded templates as active versions, once per guild. */
  async seedTemplates(guildId: string): Promise<void> {
    await this.deps.store.seedVersion(guildId, LEARNING_TO_LINKEDIN_ID, {
      name: 'Learning to LinkedIn post',
      graph: LEARNING_TO_LINKEDIN,
      classification: 'internal',
      status: 'active',
    })
  }

  /**
   * Starts an instance of an active version, or resumes it for the same `runKey`. The graph is
   * validated again against today's config, then each `agent` node is posted as a Quest through
   * the normal checks (Hall locks, Tripwires, owners), keyed `instance:node:0` so a restart posts
   * nothing twice.
   */
  async run(
    guildId: string,
    workflowId: string,
    opts: { version?: number; runKey?: string }
  ): Promise<RunResult> {
    const head = await this.deps.store.getVersion(guildId, workflowId)
    if (!head) {
      return { ok: false, error: 'not_found' }
    }
    const pinned =
      opts.version === undefined
        ? await this.deps.store.latestActive(guildId, workflowId)
        : await this.deps.store.getVersion(guildId, workflowId, opts.version)
    if (!pinned) {
      return { ok: false, error: opts.version === undefined ? 'no_active_version' : 'not_found' }
    }
    if (pinned.status !== 'active') {
      return { ok: false, error: 'version_not_active' }
    }
    if (!pinned.graph.nodes.some((n) => n.type === 'trigger.manual')) {
      return { ok: false, error: 'no_manual_trigger' }
    }
    const errors = await this.validate(guildId, pinned.graph)
    if (errors.length > 0) {
      return { ok: false, error: 'invalid_workflow', errors }
    }
    const { instance, created } = await this.deps.store.createInstance(guildId, {
      workflowId,
      version: pinned.version,
      runKey: opts.runKey ?? crypto.randomUUID(),
    })
    const posted = new Map<string, string>()
    for (const node of agentOrder(pinned.graph)) {
      const blockedBy = upstreamAgents(pinned.graph, node.id).flatMap((u) => {
        const id = posted.get(u)
        return id === undefined ? [] : [id]
      })
      const deps = {
        config: this.deps.config,
        queue: this.deps.quests,
        tripwires: this.deps.tripwires,
      }
      const title = `${pinned.name}: ${node.name ?? node.id}`.slice(0, 200)
      // Each node compiles through the existing mechanism: `agent` and `subagents` post a Quest
      // (a `subagents` one whose Member spawns the Sub-Quests with the capped `spawn_subquest`
      // tool); `team` starts the Captain's plan Quest (the capped `post_to_board` does the rest).
      const result =
        node.type === 'team'
          ? await startTeamCampaign(deps, guildId, {
              hall: node.hallId,
              campaignId: teamCampaignId(instance.id, pinned.graph.nodes.indexOf(node)),
              goal: node.goal,
              blockedBy,
            })
          : await postQuest(deps, guildId, {
              templateId: node.templateId,
              jobKey: jobKey(instance.id, node.id),
              title,
              campaignId: instance.id,
              blockedBy,
              doneCondition:
                node.type === 'agent' ? node.doneCondition : subagentsDoneCondition(node),
            })
      if (!result.ok) {
        return { ok: false, error: result.error, nodeId: node.id, runKey: instance.runKey }
      }
      posted.set(node.id, result.quest.id)
    }
    return {
      ok: true,
      instance,
      created,
      quests: [...posted].map(([nodeId, questId]) => ({ nodeId, questId })),
    }
  }

  /** Per-node status of an instance, or null when absent. */
  async state(guildId: string, instanceId: string): Promise<RunState | null> {
    const instance = await this.deps.store.getInstance(guildId, instanceId)
    if (!instance) {
      return null
    }
    const version = await this.deps.store.getVersion(guildId, instance.workflowId, instance.version)
    if (!version) {
      return null
    }
    const byId = new Map(version.graph.nodes.map((n) => [n.id, n]))
    const agentOf = (node: WorkflowNode): string | null => {
      if (startsQuests(node)) {
        return node.id
      }
      if (node.type === 'verify' || node.type === 'approval' || node.type === 'post') {
        const next = byId.get(node.of)
        return next ? agentOf(next) : null
      }
      return null
    }
    const nodes: RunState['nodes'] = []
    for (const node of version.graph.nodes) {
      const agentId = agentOf(node)
      const owner = agentId === null ? undefined : byId.get(agentId)
      const key =
        owner?.type === 'team'
          ? teamJobKey(instance.id, version.graph.nodes.indexOf(owner))
          : agentId === null
            ? null
            : jobKey(instance.id, agentId)
      const quest = key === null ? null : await this.deps.quests.findByJobKey(guildId, key)
      const fanned = node.type === 'subagents' || node.type === 'team' ? quest : null
      const finished = fanned ? await this.finishedQuests(guildId, node, fanned) : []
      nodes.push({
        id: node.id,
        type: node.type,
        questId: quest?.id ?? null,
        refs: await this.refsOf(guildId, finished),
        status: await this.statusOf(guildId, node, quest, finished),
      })
    }
    return { instance, nodes }
  }

  /** The Quests a fan-out node's result is made of: a `subagents` node's Sub-Quests, a `team` node's board Quests. */
  private async finishedQuests(
    guildId: string,
    node: WorkflowNode,
    quest: Quest
  ): Promise<Quest[]> {
    if (node.type === 'subagents') {
      const links = await this.deps.quests.children(guildId, quest.id)
      const found = await Promise.all(links.map((l) => this.deps.quests.get(guildId, l.childId)))
      return found.flatMap((q) => (q ? [q] : []))
    }
    const board: Quest[] = []
    let after: string | undefined
    do {
      const page = await this.deps.quests.list(guildId, {
        limit: 100,
        campaignId: quest.campaignId ?? '',
        ...(after === undefined ? {} : { after }),
      })
      board.push(...page.quests.filter((q) => q.board))
      after = page.next ?? undefined
    } while (after !== undefined)
    return board
  }

  /** The first artifact of each finished Quest's Handoff, in the Quests' order. */
  private async refsOf(guildId: string, quests: readonly Quest[]): Promise<string[]> {
    const refs: string[] = []
    for (const q of quests) {
      const stored =
        q.state === 'done' ? await this.deps.handoffs.get(guildId, q.id, q.attempts) : null
      const first = stored?.handoff.artifacts[0]
      if (first !== undefined) {
        refs.push(first)
      }
    }
    return refs
  }

  private async statusOf(
    guildId: string,
    node: WorkflowNode,
    quest: Quest | null,
    members: readonly Quest[]
  ): Promise<NodeStatus> {
    if (node.type === 'trigger.manual' || node.type === 'trigger.schedule') {
      return 'done'
    }
    if (!quest) {
      return 'pending'
    }
    if (node.type === 'agent' || node.type === 'subagents') {
      return AGENT_STATUS[quest.state]
    }
    if (node.type === 'team') {
      // The Captain's plan comes first; the Campaign is done when every board Quest is.
      if (quest.state !== 'done') {
        return AGENT_STATUS[quest.state]
      }
      return members.some((q) => q.state === 'dead')
        ? 'failed'
        : members.every((q) => q.state === 'done')
          ? 'done'
          : 'running'
    }
    if (node.type === 'verify') {
      const proposal = await this.deps.proposals.latestForQuest(guildId, quest.id)
      const verdict = proposal ? await this.deps.proposals.verdictFor(guildId, proposal.hash) : null
      return verdict ? (verdict.passed ? 'passed' : 'failed') : 'pending'
    }
    const seal = await this.deps.seals.forQuest(guildId, quest.id)
    if (!seal) {
      return 'pending'
    }
    if (node.type === 'approval') {
      return seal.status === 'requested'
        ? 'awaiting'
        : seal.status === 'denied' || seal.status === 'expired'
          ? 'rejected'
          : 'approved'
    }
    return seal.status === 'consumed'
      ? 'done'
      : seal.status === 'reserved'
        ? 'publishing'
        : 'pending'
  }
}
