import type { ConfigStore } from '../ports/config-store'
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
import { classifyWorkflowChange } from './classify'
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
  nodes: { id: string; type: string; status: NodeStatus; questId: string | null }[]
}

const AGENT_STATUS = {
  queued: 'queued',
  active: 'running',
  awaiting_seal: 'awaiting_seal',
  done: 'done',
  dead: 'failed',
} as const

type AgentNode = Extract<WorkflowNode, { type: 'agent' }>

/** The agent nodes that run directly before `id`, looking back through non-agent nodes. */
function upstreamAgents(graph: WorkflowGraph, id: string): string[] {
  const kinds = new Map(graph.nodes.map((n) => [n.id, n.type]))
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
      if (kinds.get(e.from) === 'agent') {
        found.add(e.from)
      } else {
        stack.push(e.from)
      }
    }
  }
  return graph.nodes.filter((n) => found.has(n.id)).map((n) => n.id)
}

/** Agent nodes in an order where every upstream agent comes first (stable by graph order). */
function agentOrder(graph: WorkflowGraph): AgentNode[] {
  const agents = graph.nodes.filter((n): n is AgentNode => n.type === 'agent')
  const done = new Set<string>()
  const ordered: AgentNode[] = []
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
    const previous = await this.deps.store.getVersion(guildId, workflowId)
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
    if (await this.deps.store.getVersion(guildId, LEARNING_TO_LINKEDIN_ID)) {
      return
    }
    await this.deps.store.saveVersion(guildId, LEARNING_TO_LINKEDIN_ID, {
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
      const result = await postQuest(
        { config: this.deps.config, queue: this.deps.quests, tripwires: this.deps.tripwires },
        guildId,
        {
          templateId: node.templateId,
          jobKey: jobKey(instance.id, node.id),
          title: `${pinned.name}: ${node.name ?? node.id}`.slice(0, 200),
          campaignId: instance.id,
          blockedBy,
          doneCondition: node.doneCondition,
        }
      )
      if (!result.ok) {
        return { ok: false, error: result.error, nodeId: node.id }
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
      if (node.type === 'agent') {
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
      const quest = agentId
        ? await this.deps.quests.findByJobKey(guildId, jobKey(instance.id, agentId))
        : null
      nodes.push({
        id: node.id,
        type: node.type,
        questId: quest?.id ?? null,
        status: await this.statusOf(guildId, node, quest),
      })
    }
    return { instance, nodes }
  }

  private async statusOf(
    guildId: string,
    node: WorkflowNode,
    quest: Quest | null
  ): Promise<NodeStatus> {
    if (node.type === 'trigger.manual' || node.type === 'trigger.schedule') {
      return 'done'
    }
    if (!quest) {
      return 'pending'
    }
    if (node.type === 'agent') {
      return AGENT_STATUS[quest.state]
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
