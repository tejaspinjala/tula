import type { ConfigStore } from '../ports/config-store'
import type { HandoffStore } from '../ports/handoff-store'
import type { Quest, QuestQueue } from '../ports/quest-queue'
import type {
  ActivateResult,
  ArchiveResult,
  PublishDraftError,
  RitePage,
  RiteRun,
  RiteRunPage,
  RiteStore,
  RiteVersion,
  RiteVersionPage,
  UnarchiveResult,
} from '../ports/rite-store'
import type { SealStore } from '../ports/seal-store'
import type { TripwireStore } from '../ports/tripwire-store'
import type { ProposalEngine } from '../proposals'
import { type PostQuestError, postQuest } from '../quests'
import { type StartTeamCampaignError, startTeamCampaign } from '../team-campaign'
import { classifyRiteChange } from './classify'
import { subagentsDoneCondition, teamCampaignId } from './fanout'
import { type RiteError, type RiteGraph, type RiteNode, riteGraph } from './graph'
import { LEARNING_TO_LINKEDIN, LEARNING_TO_LINKEDIN_ID } from './templates'
import { validateRite } from './validate'

/** Collaborators of {@link RiteEngine}. The engine holds no authority of its own. */
export interface RiteEngineDeps {
  store: RiteStore
  config: ConfigStore
  quests: QuestQueue
  tripwires: TripwireStore
  proposals: Pick<ProposalEngine, 'latestForQuest' | 'verdictFor'>
  seals: Pick<SealStore, 'forQuest'>
  /** Reads the Handoffs whose artifacts are a `subagents` or `team` node's result refs. */
  handoffs: Pick<HandoffStore, 'get'>
}

/** The outcome of {@link RiteEngine.save}. */
export type SaveResult =
  | { status: 'invalid'; errors: RiteError[] }
  | { status: 'draft'; version: RiteVersion }

/** The outcome of {@link RiteEngine.publish}. */
export type PublishResult =
  | { ok: true; status: 'active' | 'pending'; version: RiteVersion }
  | { ok: false; error: PublishDraftError | 'rite_archived' }

/** Why a run could not start or finish compiling. */
export type RunError =
  | 'not_found'
  | 'no_active_version'
  | 'version_not_active'
  | 'no_manual_trigger'
  | 'invalid_rite'
  | 'rite_archived'
  | PostQuestError
  | StartTeamCampaignError

/** The outcome of {@link RiteEngine.run}. */
export type RunResult =
  | {
      ok: true
      instance: RiteRun
      created: boolean
      quests: { nodeId: string; questId: string }[]
    }
  | { ok: false; error: RunError; nodeId?: string; errors?: RiteError[]; runKey?: string }

/** One node's status in a run. */
export type NodeStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'awaiting_seal'
  | 'awaiting_children'
  | 'done'
  | 'failed'
  | 'passed'
  | 'awaiting'
  | 'approved'
  | 'rejected'
  | 'publishing'

/** The state of one instance: its nodes and their statuses. */
export interface RunState {
  instance: RiteRun
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

type QuestNode = Extract<RiteNode, { type: 'agent' | 'subagents' | 'team' }>

const startsQuests = (n: RiteNode): n is QuestNode =>
  n.type === 'agent' || n.type === 'subagents' || n.type === 'team'

/** The Quest-starting nodes that run directly before `id`, looking back through gate nodes. */
function upstreamAgents(graph: RiteGraph, id: string): string[] {
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
function agentOrder(graph: RiteGraph): QuestNode[] {
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
 * The rite engine: validates and versions graphs, and compiles an instance's `agent` nodes to
 * Quests through the normal queue. It has no authority of its own: Verdicts, Seals, caps and the
 * bar are enforced by the same code paths as for any Quest.
 */
export class RiteEngine {
  constructor(private readonly deps: RiteEngineDeps) {}

  /** Dry-run validation against the guild's current config. */
  async validate(guildId: string, graph: unknown): Promise<RiteError[]> {
    const { config } = await this.deps.config.current(guildId)
    return validateRite(graph, config)
  }

  /**
   * Saves the next version as a draft: invalid graphs are refused with coded errors. A draft
   * never runs; {@link RiteEngine.publish} decides whether it goes live. A repeated `saveId`, or
   * an input equal to the newest version, returns that version and writes nothing.
   */
  async save(
    guildId: string,
    riteId: string,
    input: { name: string; graph: unknown; saveId?: string | undefined }
  ): Promise<SaveResult> {
    const errors = await this.validate(guildId, input.graph)
    if (errors.length > 0) {
      return { status: 'invalid', errors }
    }
    const graph = riteGraph.parse(input.graph)
    const previous = await this.deps.store.latestActive(guildId, riteId)
    const version = await this.deps.store.saveDraft(
      guildId,
      riteId,
      {
        name: input.name,
        graph,
        classification: classifyRiteChange(previous?.graph ?? null, graph),
        status: 'draft',
      },
      input.saveId
    )
    return { status: 'draft', version }
  }

  /**
   * Publishes a draft over the active version it was based on (null for none). Classification is
   * code: a draft not provably no wider than the active version (or a first version) becomes
   * `pending` and goes live only through {@link RiteEngine.confirm}; an internal one is active at
   * once. A moved active version is `stale`.
   */
  async publish(
    guildId: string,
    riteId: string,
    version: number,
    basedOn: number | null
  ): Promise<PublishResult> {
    const draft = await this.deps.store.getVersion(guildId, riteId, version)
    if (!draft) {
      return { ok: false, error: 'not_found' }
    }
    if ((await this.deps.store.archivedAt(guildId, riteId)) !== null) {
      return { ok: false, error: 'rite_archived' }
    }
    const active = await this.deps.store.latestActive(guildId, riteId)
    const kind = classifyRiteChange(active?.graph ?? null, draft.graph)
    const widening = kind === 'widening' || draft.classification === 'widening'
    const outcome = widening ? 'pending' : 'active'
    const result = await this.deps.store.publishDraft(guildId, riteId, {
      version,
      basedOn,
      classifiedAgainst: active?.version ?? null,
      outcome,
    })
    return result.ok ? { ok: true, status: outcome, version: result.version } : result
  }

  /**
   * Confirms a pending version (the caller has re-authenticated). `stale` when the active version
   * moved since it was published, so a confirm never rolls a newer version back; `rite_archived`
   * when the Rite is archived (unarchive and publish again).
   */
  async confirm(guildId: string, riteId: string, version: number): Promise<ActivateResult> {
    return this.deps.store.activate(guildId, riteId, version)
  }

  /** Whether the Rite is archived, so a caller can refuse before spending a re-authentication proof. */
  async isArchived(guildId: string, riteId: string): Promise<boolean> {
    return (await this.deps.store.archivedAt(guildId, riteId)) !== null
  }

  /** Rites in id order after `after`. */
  list(
    guildId: string,
    page: { after?: string; limit: number; archived?: boolean }
  ): Promise<RitePage> {
    return this.deps.store.list(guildId, page)
  }

  /**
   * Archives a Rite: hidden from the list, no new run or publish. A run in flight completes, since
   * its Quests are already on the queue.
   */
  archive(guildId: string, riteId: string): Promise<ArchiveResult> {
    return this.deps.store.archive(guildId, riteId)
  }

  /** Unarchives a Rite; its active version is superseded, so it must be published again to run. */
  unarchive(guildId: string, riteId: string): Promise<UnarchiveResult> {
    return this.deps.store.unarchive(guildId, riteId)
  }

  /** A version (the latest of any status when `version` is omitted) and the newest runnable one. */
  async get(
    guildId: string,
    riteId: string,
    version?: number
  ): Promise<{ version: RiteVersion; activeVersion: number | null } | null> {
    const found = await this.deps.store.getVersion(guildId, riteId, version)
    if (!found) {
      return null
    }
    const active = await this.deps.store.latestActive(guildId, riteId)
    return { version: found, activeVersion: active?.version ?? null }
  }

  /** Versions newest first, below `before`. */
  versions(
    guildId: string,
    riteId: string,
    page: { before?: number; limit: number }
  ): Promise<RiteVersionPage> {
    return this.deps.store.versions(guildId, riteId, page)
  }

  /** Instances of a Rite in id order after `after`. */
  runs(
    guildId: string,
    riteId: string,
    page: { after?: string; limit: number }
  ): Promise<RiteRunPage> {
    return this.deps.store.listInstances(guildId, riteId, page)
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
   * nothing twice. An archived Rite refuses every run, including a retry of an existing `runKey`:
   * there is no resume while archived (unarchive and publish to retry).
   */
  async run(
    guildId: string,
    riteId: string,
    opts: { version?: number; runKey?: string }
  ): Promise<RunResult> {
    const head = await this.deps.store.getVersion(guildId, riteId)
    if (!head) {
      return { ok: false, error: 'not_found' }
    }
    if ((await this.deps.store.archivedAt(guildId, riteId)) !== null) {
      return { ok: false, error: 'rite_archived' }
    }
    const pinned =
      opts.version === undefined
        ? await this.deps.store.latestActive(guildId, riteId)
        : await this.deps.store.getVersion(guildId, riteId, opts.version)
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
      return { ok: false, error: 'invalid_rite', errors }
    }
    const { instance, created } = await this.deps.store.createInstance(guildId, {
      riteId,
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
    const version = await this.deps.store.getVersion(guildId, instance.riteId, instance.version)
    if (!version) {
      return null
    }
    const byId = new Map(version.graph.nodes.map((n) => [n.id, n]))
    const agentOf = (node: RiteNode): string | null => {
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
  private async finishedQuests(guildId: string, node: RiteNode, quest: Quest): Promise<Quest[]> {
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
    node: RiteNode,
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
      return quest.state === 'queued' && quest.waitingOn.length > 0
        ? 'awaiting_children'
        : AGENT_STATUS[quest.state]
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
    return seal.status === 'consumed' || seal.status === 'council_approved'
      ? 'done'
      : seal.status === 'reserved'
        ? 'publishing'
        : 'pending'
  }
}
