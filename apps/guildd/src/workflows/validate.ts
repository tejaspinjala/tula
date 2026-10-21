import {
  campaignQuestCap,
  type GuildConfig,
  hallMemberCap,
  spawnChildrenCap,
  spawnDepthCap,
} from '../guild-config'
import { POSTABLE_TEMPLATES, type QuestTemplate } from '../quests'
import { MAX_DONE_CONDITION, subagentsDoneCondition } from './fanout'
import { type WorkflowError, type WorkflowGraph, type WorkflowNode, workflowGraph } from './graph'

const BRIEF_REF = /\{\{\s*nodes\.([a-z][a-z0-9_-]{0,63})\.output\s*\}\}/g

type Adjacency = Map<string, string[]>

function adjacency(edges: WorkflowGraph['edges'], known: ReadonlySet<string>): Adjacency {
  const out: Adjacency = new Map()
  for (const e of edges) {
    if (known.has(e.from) && known.has(e.to)) {
      out.set(e.from, [...(out.get(e.from) ?? []), e.to])
    }
  }
  return out
}

/** Nodes reachable from `starts` (inclusive) without ever entering `blocked`. */
function reach(starts: readonly string[], out: Adjacency, blocked?: string): Set<string> {
  const seen = new Set<string>()
  const stack = starts.filter((s) => s !== blocked)
  while (stack.length > 0) {
    const id = stack.pop()
    if (id === undefined || seen.has(id)) {
      continue
    }
    seen.add(id)
    for (const next of out.get(id) ?? []) {
      if (next !== blocked) {
        stack.push(next)
      }
    }
  }
  return seen
}

function hasCycle(ids: readonly string[], out: Adjacency): boolean {
  const state = new Map<string, 'open' | 'done'>()
  const visit = (id: string): boolean => {
    const s = state.get(id)
    if (s === 'open') {
      return true
    }
    if (s === 'done') {
      return false
    }
    state.set(id, 'open')
    const found = (out.get(id) ?? []).some(visit)
    state.set(id, 'done')
    return found
  }
  return ids.some(visit)
}

/** Nodes that start Quests: they cannot follow a gate, and they spend. */
const startsQuests = (
  n: WorkflowNode
): n is Extract<WorkflowNode, { type: 'agent' | 'subagents' | 'team' }> =>
  n.type === 'agent' || n.type === 'subagents' || n.type === 'team'

const isTrigger = (n: WorkflowNode) => n.type === 'trigger.manual' || n.type === 'trigger.schedule'

/**
 * Deterministic save-time validation of a workflow graph (SPEC 27.3 subset): schema, graph shape,
 * references, the gate rule and the budget. Returns every error found; empty means valid. Never a
 * model decision: the gate rule is dominance in the graph, `post` <- `approval` <- `verify` <-
 * `agent`, each bound by `of`, so every path to a `post` passes the Verdict and then the Seal on
 * the same Proposal hash.
 */
export function validateWorkflow(
  input: unknown,
  config: GuildConfig,
  templates: readonly QuestTemplate[] = POSTABLE_TEMPLATES
): WorkflowError[] {
  const parsed = workflowGraph.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return [
      {
        code: 'schema_invalid',
        message: issue ? `${issue.path.join('.') || 'graph'}: ${issue.message}` : 'invalid graph',
      },
    ]
  }
  const { nodes, edges } = parsed.data
  const errors: WorkflowError[] = []
  const add = (code: string, message: string, nodeId?: string) =>
    errors.push({ code, message, ...(nodeId === undefined ? {} : { nodeId }) })

  const byId = new Map<string, WorkflowNode>()
  for (const n of nodes) {
    if (byId.has(n.id)) {
      add('duplicate_node', `node id ${n.id} is used twice`, n.id)
    } else {
      byId.set(n.id, n)
    }
  }
  const known = new Set(byId.keys())
  for (const e of edges) {
    for (const end of [e.from, e.to]) {
      if (!known.has(end)) {
        add('unknown_edge_node', `an edge names the unknown node ${end}`, end)
      }
    }
  }
  const triggers = [...byId.values()].filter(isTrigger)
  if (triggers.length === 0) {
    add('no_trigger', 'a workflow needs at least one trigger')
  }
  for (const e of edges) {
    const target = byId.get(e.to)
    if (target && isTrigger(target) && known.has(e.from)) {
      add('trigger_has_input', `trigger ${e.to} cannot have an incoming edge`, e.to)
    }
  }

  const out = adjacency(edges, known)
  const triggerIds = triggers.map((t) => t.id)
  const reachable = reach(triggerIds, out)
  for (const id of known) {
    if (!reachable.has(id)) {
      add('unreachable_node', `node ${id} cannot be reached from a trigger`, id)
    }
  }
  // An agent after a gate would start before the Verdict and Seal settle (blockedBy covers agents
  // only), so this subset refuses it.
  const gates = [...byId.values()].filter((n) => n.type === 'verify' || n.type === 'approval')
  const afterGate = reach(
    gates.flatMap((g) => out.get(g.id) ?? []),
    out
  )
  for (const n of byId.values()) {
    if (startsQuests(n) && afterGate.has(n.id)) {
      add('agent_after_gate', `${n.type} ${n.id} runs after a verify or approval gate`, n.id)
    }
  }
  // A team Campaign's Quests are on a Quest Board and finish on their own clock, so nothing can be
  // ordered after it (blockedBy covers a single Quest).
  const teams = [...byId.values()].filter((n) => n.type === 'team')
  const afterTeam = reach(
    teams.flatMap((t) => out.get(t.id) ?? []),
    out
  )
  for (const n of byId.values()) {
    if (startsQuests(n) && afterTeam.has(n.id)) {
      add('node_after_team', `${n.type} ${n.id} runs after a team node`, n.id)
    }
  }
  if (hasCycle([...known], out)) {
    add('cycle', 'the graph contains a cycle')
  }
  for (const n of byId.values()) {
    // A fan-out or team node may end a path: its output is its results, not a draft to publish.
    const mayEnd = n.type === 'post' || n.type === 'subagents' || n.type === 'team'
    if (!mayEnd && (out.get(n.id) ?? []).length === 0) {
      add('dead_end', `node ${n.id} ends a path without reaching a post`, n.id)
    }
  }

  // Ancestors for brief references.
  const ancestorsOf = (id: string): Set<string> => {
    const back: Adjacency = new Map()
    for (const [from, tos] of out) {
      for (const to of tos) {
        back.set(to, [...(back.get(to) ?? []), from])
      }
    }
    const seen = reach([id], back)
    seen.delete(id)
    return seen
  }

  const checkTeam = (
    n: Extract<WorkflowNode, { type: 'team' }>,
    hall: GuildConfig['halls'][number] | undefined
  ) => {
    if (hall && !hall.captain) {
      add('no_captain', `Hall ${hall.id} has no Captain to lead a team`, n.id)
    }
    if (hall && n.maxMembers > hallMemberCap(hall)) {
      add(
        'member_cap',
        `${n.maxMembers} Members exceed Hall ${hall.id}'s cap of ${hallMemberCap(hall)}`,
        n.id
      )
    }
    if (n.maxQuests > campaignQuestCap(config)) {
      add(
        'campaign_cap',
        `${n.maxQuests} Quests exceed the cap of ${campaignQuestCap(config)} per Campaign`,
        n.id
      )
    }
  }

  let budgetMicros = 0
  for (const n of byId.values()) {
    if (n.type === 'trigger.schedule' && !config.schedules.some((s) => s.id === n.scheduleId)) {
      add('unknown_schedule', `schedule ${n.scheduleId} is not in the guild config`, n.id)
    }
    if (!startsQuests(n)) {
      continue
    }
    budgetMicros += Math.round(n.maxUsd * 1_000_000)
    const hall = config.halls.find((h) => h.id === n.hallId)
    if (!hall) {
      add('unknown_hall', `Hall ${n.hallId} does not exist`, n.id)
    } else if (hall.locked) {
      add('hall_locked', `Hall ${n.hallId} is locked`, n.id)
    }
    if (n.type === 'team') {
      checkTeam(n, hall)
      continue
    }
    const template = templates.find((t) => t.id === n.templateId)
    if (!template) {
      add('unknown_template', `Quest template ${n.templateId} does not exist`, n.id)
    } else if (template.hallId !== n.hallId) {
      add(
        'template_hall_mismatch',
        `template ${n.templateId} belongs to Hall ${template.hallId}`,
        n.id
      )
    }
    if (n.type === 'subagents') {
      if (n.briefs.length > spawnChildrenCap(config)) {
        add(
          'children_cap',
          `${n.briefs.length} briefs exceed the cap of ${spawnChildrenCap(config)} Sub-Quests per Quest`,
          n.id
        )
      }
      if (subagentsDoneCondition(n).length > MAX_DONE_CONDITION) {
        add('briefs_too_long', 'the briefs do not fit the coordinating Quest', n.id)
      }
      if (spawnDepthCap(config) < 1) {
        add('depth_cap', 'the guild allows no Sub-Quest depth, so nothing can be spawned', n.id)
      }
      continue
    }
    const upstream = ancestorsOf(n.id)
    for (const match of n.briefTemplate.matchAll(BRIEF_REF)) {
      const ref = match[1]
      if (ref === undefined || byId.get(ref)?.type !== 'agent' || !upstream.has(ref)) {
        add('bad_reference', `brief names ${ref ?? '?'}, which is not an upstream agent node`, n.id)
      }
    }
  }
  if (budgetMicros > config.caps.dailySpendCents * 10_000) {
    add('budget_exceeded', 'the sum of maxUsd exceeds the daily spend cap')
  }

  // The gate rule.
  const bound = (
    n: WorkflowNode,
    want: WorkflowNode['type'],
    report = true
  ): WorkflowNode | null => {
    if (n.type !== 'verify' && n.type !== 'approval' && n.type !== 'post') {
      return null
    }
    const target = byId.get(n.of)
    if (target?.type !== want) {
      if (report) {
        add(
          'bad_binding',
          `${n.type} ${n.id} must be bound to ${/^[aeiou]/.test(want) ? 'an' : 'a'} ${want} node`,
          n.id
        )
      }
      return null
    }
    return target
  }
  const dominated = (n: WorkflowNode, by: WorkflowNode) => !reach(triggerIds, out, by.id).has(n.id)
  for (const n of byId.values()) {
    if (n.type === 'verify') {
      const agent = bound(n, 'agent')
      if (agent && !dominated(n, agent)) {
        add('gate_undrafted', `a path reaches verify ${n.id} without passing ${agent.id}`, n.id)
      }
    } else if (n.type === 'approval') {
      const verify = bound(n, 'verify')
      if (verify && !dominated(n, verify)) {
        add(
          'gate_unverified',
          `a path reaches approval ${n.id} without passing verify ${verify.id}`,
          n.id
        )
      }
    } else if (n.type === 'post') {
      const approval = bound(n, 'approval')
      if (approval && !dominated(n, approval)) {
        add(
          'gate_unapproved',
          `a path reaches post ${n.id} without passing approval ${approval.id}`,
          n.id
        )
      }
      const verify = approval ? bound(approval, 'verify', false) : null
      const agent = verify ? bound(verify, 'agent', false) : null
      if (agent?.type === 'agent') {
        const template = templates.find((t) => t.id === agent.templateId)
        if (template && !template.requiresSeal) {
          add('unsealed_template', `template ${template.id} does not require a Seal`, agent.id)
        }
      }
    }
  }
  return errors
}
