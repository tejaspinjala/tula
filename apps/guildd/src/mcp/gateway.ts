import { z } from 'zod'
import { BRIEF_TOKEN_CAP, compileBrief } from '../brief'
import { questConcurrency } from '../guild-config'
import type { Clock } from '../ports/clock'
import type { ConfigStore } from '../ports/config-store'
import type { GateStore } from '../ports/gate-store'
import { type HandoffStore, handoff, hashHandoff } from '../ports/handoff-store'
import type { KeyProvider } from '../ports/key-provider'
import { NoteError, type NoteStore } from '../ports/note-store'
import type { ObjectStore } from '../ports/object-store'
import { hasLiveLease, type Quest, QuestError, type QuestQueue } from '../ports/quest-queue'
import { type ToolsetStore, toolsetScope } from '../ports/toolset-store'
import type { TripwireStore } from '../ports/tripwire-store'
import type { ProposalEngine } from '../proposals'
import { QUEST_TEMPLATES } from '../quests'
import { hallNote, hallNotes } from './archive-scope'
import { mintToken, verifyToken } from './tokens'
import {
  claimQuestArgs,
  completeQuestArgs,
  getArtifactArgs,
  type LeaseHandle,
  leaseHandle,
  MAX_TOOL_ARTIFACT_BYTES,
  MCP_PROTOCOL_VERSION,
  putArtifactArgs,
  readArchiveArgs,
  readBriefArgs,
  roleToolNames,
  submitProposalArgs,
  TOOL_CATALOG,
  type ToolDef,
  writeArchiveArgs,
} from './tools'

/** Ports and settings the gateway is built from. */
export interface McpGatewayDeps {
  quests: QuestQueue
  config: ConfigStore
  notes: NoteStore
  objectStore: ObjectStore
  handoffs: HandoffStore
  toolsets: ToolsetStore
  /** Files a Proposal (and its deterministic Verdict) for `submit_proposal`. */
  proposals: ProposalEngine
  keys: KeyProvider
  clock: Clock
  /** Bar the Gates: read first on every tool list and call; a barred guild is denied before any work. */
  gates: Pick<GateStore, 'isBarred'>
  /** A paused Hall leases none of its Quests. */
  tripwires: Pick<TripwireStore, 'isPaused'>
  /** The tools on offer; defaults to {@link TOOL_CATALOG}. A role's list is frozen per Campaign from it. */
  catalog?: readonly ToolDef[]
  /** Largest Brief in tokens; defaults to {@link BRIEF_TOKEN_CAP}. */
  briefTokenCap?: number
  /** Lease length at claim; defaults to ten minutes. */
  leaseMs?: number
  /** How long an assignment may be used to claim; defaults to fifteen minutes. */
  assignmentMs?: number
  /** Artifact-store calls are abandoned after this; defaults to ten seconds. */
  storeTimeoutMs?: number
}

/** What the gateway answers: an HTTP status and a JSON-RPC body (null for a notification). */
export interface McpReply {
  status: 200 | 202 | 400 | 401
  body: unknown
}

const envelope = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.string(), z.number()]).nullish(),
  method: z.string().min(1).max(100),
  params: z.unknown().optional(),
})

const listParams = z.union([
  z.strictObject({ assignment: z.string().min(1).max(2000) }),
  z.strictObject({ lease: leaseHandle }),
])
/** Where a request carries its token: `params` for a list, `params.arguments` for a call. */
const tokenCarrier = z.object({
  assignment: z.string().min(1).max(2000).optional(),
  lease: z.object({ token: z.string().min(1).max(2000) }).optional(),
})
const carrierParams = tokenCarrier.extend({ arguments: tokenCarrier.optional() })
const callParams = z.object({
  name: z.string().min(1).max(100),
  arguments: z.record(z.string(), z.unknown()).default({}),
})

/** Who is calling, as derived from a verified token: the guild comes from here, never from the caller. */
interface Caller {
  guild: string
  quest: Quest
  member: string
}

/** True when the Quest's template needs a Seal before anything is posted. */
const requiresSeal = (quest: Quest): boolean =>
  QUEST_TEMPLATES.find((t) => t.id === quest.templateId)?.requiresSeal ?? false

type Id = string | number | null

class Denied extends Error {
  constructor(readonly code: string) {
    super(code)
  }
}

class StoreTimeout extends Error {}

type ToolData = Record<string, unknown>
interface ToolReply {
  data: ToolData
  isError: boolean
}
const ok = (data: ToolData): ToolReply => ({ data, isError: false })
const refuse = (error: string, extra: ToolData = {}): ToolReply => ({
  data: { error, ...extra },
  isError: true,
})

const rpcError = (
  id: Id,
  code: number,
  message: string,
  status: 200 | 400 | 401 = 200
): McpReply => ({
  status,
  body: { jsonrpc: '2.0', id, error: { code, message } },
})

/**
 * The stateless MCP gateway (spec 2026-07-28): every request stands alone and authorises itself.
 * `claim_quest` presents an assignment token; every other tool presents the lease handle (Quest,
 * attempt, token) it got at claim. The guild is read from the signed token and the Quest's live
 * lease is checked against the queue on every call, so a lapsed or superseded lease (the attempt
 * is the fencing token) opens nothing. Each role's tool list is frozen per Campaign on first use.
 * No model is called here.
 */
export class McpGateway {
  private readonly catalog: readonly ToolDef[]
  private readonly leaseMs: number
  private readonly assignmentMs: number
  private readonly storeTimeoutMs: number

  constructor(private readonly deps: McpGatewayDeps) {
    this.catalog = deps.catalog ?? TOOL_CATALOG
    this.leaseMs = deps.leaseMs ?? 10 * 60_000
    this.assignmentMs = deps.assignmentMs ?? 15 * 60_000
    this.storeTimeoutMs = deps.storeTimeoutMs ?? 10_000
  }

  /** Mints the token that lets the Quest's owner claim it: issued by the dispatcher, never by a tool. */
  async assign(guildId: string, quest: Quest): Promise<string> {
    return mintToken(this.deps.keys, {
      k: 'assign',
      g: guildId,
      q: quest.id,
      m: quest.ownerId,
      exp: this.deps.clock.now().getTime() + this.assignmentMs,
    })
  }

  /**
   * Mints the lease handle for a Quest the dispatcher has already claimed (the worker never
   * claims it itself): the same signed lease `claim_quest` hands out, for the attempt the Quest
   * is on.
   */
  async lease(guildId: string, quest: Quest): Promise<LeaseHandle> {
    return {
      questId: quest.id,
      attempt: quest.attempts,
      token: await mintToken(this.deps.keys, {
        k: 'lease',
        g: guildId,
        q: quest.id,
        a: quest.attempts,
        m: quest.ownerId,
      }),
    }
  }

  /**
   * The guild named by the request's signed token, or null when it carries none or the signature
   * does not verify. Only the signature is checked, so it is safe to key an abuse bucket on.
   */
  async verifiedGuild(raw: unknown): Promise<string | null> {
    const request = envelope.safeParse(raw)
    const params = carrierParams.safeParse(request.success ? request.data.params : undefined)
    if (!params.success) {
      return null
    }
    const token =
      params.data.assignment ??
      params.data.lease?.token ??
      params.data.arguments?.assignment ??
      params.data.arguments?.lease?.token
    const claims = token ? await verifyToken(this.deps.keys, token) : null
    return claims?.g ?? null
  }

  /** Handles one JSON-RPC request body. */
  async handle(raw: unknown): Promise<McpReply> {
    const request = envelope.safeParse(raw)
    if (!request.success) {
      return rpcError(null, -32600, 'invalid_request', 400)
    }
    const { id, method, params } = request.data
    if (id === undefined || id === null) {
      return { status: 202, body: null }
    }
    try {
      switch (method) {
        case 'initialize':
          return this.result(id, {
            protocolVersion: MCP_PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'guildhall', version: '1' },
          })
        case 'ping':
          return this.result(id, {})
        case 'tools/list':
          return await this.list(id, params)
        case 'tools/call':
          return await this.call(id, params)
        default:
          return rpcError(id, -32601, 'method_not_found')
      }
    } catch (error) {
      if (error instanceof Denied) {
        return rpcError(id, -32001, error.code, 401)
      }
      throw error
    }
  }

  private result(id: Id, result: unknown): McpReply {
    return { status: 200, body: { jsonrpc: '2.0', id, result } }
  }

  private async list(id: Id, params: unknown): Promise<McpReply> {
    const parsed = listParams.safeParse(params)
    if (!parsed.success) {
      return rpcError(id, -32602, 'invalid_arguments')
    }
    const caller =
      'assignment' in parsed.data
        ? await this.fromAssignment(parsed.data.assignment)
        : await this.fromLease(parsed.data.lease, false)
    const names = await this.exposed(caller)
    const tools = names.flatMap((name) => {
      const def = this.catalog.find((t) => t.name === name)
      return def
        ? [{ name, description: def.description, inputSchema: z.toJSONSchema(def.args) }]
        : []
    })
    return this.result(id, { tools })
  }

  private async call(id: Id, params: unknown): Promise<McpReply> {
    const parsed = callParams.safeParse(params)
    if (!parsed.success) {
      return rpcError(id, -32602, 'invalid_arguments')
    }
    const def = this.catalog.find((t) => t.name === parsed.data.name)
    if (!def) {
      return rpcError(id, -32602, 'unknown_tool')
    }
    const args = def.args.safeParse(parsed.data.arguments)
    if (!args.success) {
      return rpcError(id, -32602, 'invalid_arguments')
    }
    let reply: ToolReply
    try {
      reply = await this.run(def.name, args.data)
    } catch (error) {
      if (error instanceof StoreTimeout) {
        reply = refuse('store_timeout')
      } else if (error instanceof Denied && error.code === 'unknown_tool') {
        return rpcError(id, -32602, 'unknown_tool')
      } else {
        throw error
      }
    }
    return this.result(id, {
      content: [{ type: 'text', text: JSON.stringify(reply.data) }],
      structuredContent: reply.data,
      isError: reply.isError,
    })
  }

  /** Authorises the call, checks the tool is on the role's frozen list, and runs it. */
  private async run(name: string, args: unknown): Promise<ToolReply> {
    if (name === 'claim_quest') {
      const { assignment } = claimQuestArgs.parse(args)
      const caller = await this.fromAssignment(assignment)
      await this.expose(caller, name)
      return this.claim(caller)
    }
    if (name === 'complete_quest') {
      const a = completeQuestArgs.parse(args)
      const caller = await this.fromLease(a.lease, true)
      await this.expose(caller, name)
      return this.complete(caller, a.lease, a.handoff)
    }
    const lease = z.object({ lease: leaseHandle }).parse(args).lease
    const caller = await this.fromLease(lease, false)
    await this.expose(caller, name)
    switch (name) {
      case 'read_brief':
        readBriefArgs.parse(args)
        return this.briefReply(caller, await this.exposed(caller), (brief) =>
          ok({ brief, requiresSeal: requiresSeal(caller.quest) })
        )
      case 'submit_proposal':
        return this.submitProposal(caller, submitProposalArgs.parse(args))
      case 'read_archive':
        return this.readArchive(caller, readArchiveArgs.parse(args))
      case 'write_archive':
        return this.writeArchive(caller, writeArchiveArgs.parse(args))
      case 'get_artifact':
        return this.getArtifact(caller, getArtifactArgs.parse(args).hash)
      case 'put_artifact':
        return this.putArtifact(caller, putArtifactArgs.parse(args).contentBase64)
      default:
        throw new Denied('unknown_tool')
    }
  }

  /** Bar the Gates: read on every call, right after the token names its guild, before any other work. */
  private async requireOpen(guild: string): Promise<void> {
    if (await this.deps.gates.isBarred(guild)) {
      throw new Denied('gates_barred')
    }
  }

  private async fromAssignment(token: string): Promise<Caller> {
    const claims = await verifyToken(this.deps.keys, token)
    if (claims?.k !== 'assign' || claims.exp <= this.deps.clock.now().getTime()) {
      throw new Denied('invalid_assignment')
    }
    await this.requireOpen(claims.g)
    const quest = await this.deps.quests.get(claims.g, claims.q)
    if (!quest || quest.ownerId !== claims.m) {
      throw new Denied('invalid_assignment')
    }
    return { guild: claims.g, quest, member: claims.m }
  }

  /**
   * Resolves a lease handle to its caller. `invalid_lease` for a token that is forged or names
   * another Quest or attempt; `lease_expired` for a genuine one whose lease lapsed or was
   * superseded. With `allowFinished`, a Quest that this very delivery already completed passes,
   * so a retried completion is safe.
   */
  private async fromLease(handle: LeaseHandle, allowFinished: boolean): Promise<Caller> {
    const claims = await verifyToken(this.deps.keys, handle.token)
    if (claims?.k !== 'lease' || claims.q !== handle.questId || claims.a !== handle.attempt) {
      throw new Denied('invalid_lease')
    }
    await this.requireOpen(claims.g)
    const quest = await this.deps.quests.get(claims.g, claims.q)
    if (!quest || quest.ownerId !== claims.m) {
      throw new Denied('invalid_lease')
    }
    const finished = allowFinished && quest.state === 'done' && quest.attempts === claims.a
    if (!finished && (quest.attempts !== claims.a || !hasLiveLease(quest, this.deps.clock.now()))) {
      throw new Denied('lease_expired')
    }
    return { guild: claims.g, quest, member: claims.m }
  }

  /** The role's tool list for the caller's Campaign: frozen at first use, minus tools since removed. */
  private async exposed(caller: Caller): Promise<string[]> {
    const { quest } = caller
    const frozen = await this.deps.toolsets.freeze(
      caller.guild,
      toolsetScope(quest.campaignId, quest.id),
      quest.rank,
      roleToolNames(quest.rank, this.catalog)
    )
    return frozen.filter((n) => this.catalog.some((t) => t.name === n))
  }

  private async expose(caller: Caller, name: string): Promise<void> {
    if (!(await this.exposed(caller)).includes(name)) {
      throw new Denied('unknown_tool')
    }
  }

  private async bounded<T>(call: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new StoreTimeout()), this.storeTimeoutMs)
    })
    return Promise.race([call, timeout]).finally(() => clearTimeout(timer))
  }

  private async claim(caller: Caller): Promise<ToolReply> {
    const { guild, quest, member } = caller
    if (await this.deps.tripwires.isPaused(guild, quest.hallId)) {
      return refuse('hall_paused')
    }
    const { config } = await this.deps.config.current(guild)
    let claimed: Quest | null
    try {
      claimed = await this.deps.quests.claim(guild, {
        leaseMs: this.leaseMs,
        maxActive: questConcurrency(config),
        questId: quest.id,
      })
    } catch (error) {
      if (error instanceof QuestError) {
        return refuse(error.code)
      }
      throw error
    }
    if (!claimed) {
      return refuse('not_claimable')
    }
    const lease = {
      questId: claimed.id,
      attempt: claimed.attempts,
      token: await mintToken(this.deps.keys, {
        k: 'lease',
        g: guild,
        q: claimed.id,
        a: claimed.attempts,
        m: member,
      }),
    }
    const tools = await this.exposed({ ...caller, quest: claimed })
    return this.briefReply({ ...caller, quest: claimed }, tools, (brief) =>
      ok({ lease, brief, tools, leaseExpiresAt: claimed.leaseExpiresAt })
    )
  }

  /** Compiles the Brief and hands it to `onBrief`; a Quest too large for the cap is a coded refusal. */
  private async briefReply(
    caller: Caller,
    tools: readonly string[],
    onBrief: (brief: string) => ToolReply
  ): Promise<ToolReply> {
    try {
      return onBrief(await this.compile(caller, tools))
    } catch (error) {
      if (error instanceof Error && error.message === 'brief_too_large') {
        return refuse('brief_too_large')
      }
      throw error
    }
  }

  private async compile(caller: Caller, tools: readonly string[]): Promise<string> {
    const { guild, quest } = caller
    const pointers = await hallNotes(this.deps.notes, guild, quest.hallId, { limit: 20 })
    return compileBrief(
      {
        quest,
        role: quest.rank,
        tools,
        notes: pointers.notes.map((n) => ({ id: n.id, title: n.title })),
      },
      this.deps.briefTokenCap ?? BRIEF_TOKEN_CAP
    ).text
  }

  private async readArchive(
    caller: Caller,
    a: z.infer<typeof readArchiveArgs>
  ): Promise<ToolReply> {
    const { guild, quest } = caller
    if (a.noteId !== undefined) {
      const note = await hallNote(this.deps.notes, guild, quest.hallId, a.noteId)
      return note ? ok({ note }) : refuse('not_found')
    }
    const page = await hallNotes(this.deps.notes, guild, quest.hallId, {
      query: a.query,
      after: a.after,
      limit: a.limit,
    })
    return ok({ notes: page.notes, next: page.next })
  }

  private async writeArchive(
    caller: Caller,
    a: z.infer<typeof writeArchiveArgs>
  ): Promise<ToolReply> {
    try {
      const note = await this.deps.notes.add(
        caller.guild,
        {
          kind: 'text',
          title: a.title,
          body: a.body,
          claim: a.claim,
          ...(a.evidence === undefined ? {} : { evidence: a.evidence }),
        },
        caller.quest.hallId
      )
      return ok({ id: note.id, version: note.version })
    } catch (error) {
      if (error instanceof NoteError) {
        return refuse(error.code)
      }
      throw error
    }
  }

  /**
   * Files the draft as a Proposal of the leased Quest through the Proposal engine, so the Verdict
   * checks run unchanged. The evidence links join the filed text, so the Verdict judges exactly what
   * a Seal would post. Idempotent: the engine returns the existing Proposal for the same text.
   */
  private async submitProposal(
    caller: Caller,
    a: z.infer<typeof submitProposalArgs>
  ): Promise<ToolReply> {
    const content =
      a.evidenceLinks.length === 0
        ? a.text
        : `${a.text}\n\nSources:\n${a.evidenceLinks.map((l) => `- ${l}`).join('\n')}`
    const proposal = await this.deps.proposals.propose(caller.guild, {
      questId: caller.quest.id,
      author: caller.member,
      kind: 'post',
      content,
    })
    return ok({
      id: proposal.id,
      hash: proposal.hash,
      passed: proposal.verdict.passed,
      findings: proposal.verdict.findings,
    })
  }

  private async getArtifact(caller: Caller, hash: string): Promise<ToolReply> {
    const { guild, quest } = caller
    if (!(await this.deps.handoffs.holds(guild, quest.id, hash))) {
      return refuse('not_found')
    }
    const bytes = await this.bounded(this.deps.objectStore.get(guild, hash))
    return bytes
      ? ok({ contentBase64: Buffer.from(bytes).toString('base64') })
      : refuse('not_found')
  }

  private async putArtifact(caller: Caller, contentBase64: string): Promise<ToolReply> {
    const bytes = new Uint8Array(Buffer.from(contentBase64, 'base64'))
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_TOOL_ARTIFACT_BYTES) {
      return refuse('invalid_content')
    }
    const hash = await this.bounded(this.deps.objectStore.put(caller.guild, bytes))
    await this.deps.handoffs.attach(caller.guild, caller.quest.id, hash, bytes.byteLength)
    return ok({ hash, size: bytes.byteLength })
  }

  /**
   * Records the Handoff and finishes the Quest when it is met with no open items. Does not route
   * through a Seal: #26 routes Seal-requiring Quests through submitForSeal.
   */
  private async complete(caller: Caller, lease: LeaseHandle, raw: unknown): Promise<ToolReply> {
    const { guild, quest, member } = caller
    const parsed = handoff.safeParse(raw)
    const issues: Array<{ path: string; message: string }> = parsed.success
      ? []
      : parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
    if (parsed.success) {
      const h = parsed.data
      if (h.doneCondition !== quest.doneCondition) {
        issues.push({
          path: 'doneCondition',
          message: `must equal the Quest's done-condition: ${quest.doneCondition}`,
        })
      }
      for (const hash of new Set([
        ...h.artifacts,
        ...h.evidence.filter((e) => e.kind === 'artifact').map((e) => e.ref),
      ])) {
        if (!(await this.deps.handoffs.holds(guild, quest.id, hash))) {
          issues.push({
            path: h.artifacts.includes(hash) ? 'artifacts' : 'evidence',
            message: `artifact ${hash} is not held by this Quest; put_artifact it first`,
          })
        }
      }
      for (const ref of h.evidence.filter((e) => e.kind === 'note')) {
        if (!(await hallNote(this.deps.notes, guild, quest.hallId, ref.ref))) {
          issues.push({
            path: 'evidence',
            message: `note ${ref.ref} is not in this Hall's Archive`,
          })
        }
      }
    }
    if (!parsed.success || issues.length > 0) {
      return refuse('invalid_handoff', { issues })
    }
    const { stored } = await this.deps.handoffs.record(
      guild,
      quest.id,
      lease.attempt,
      member,
      parsed.data
    )
    if (stored.hash !== hashHandoff(parsed.data)) {
      return refuse('handoff_conflict', {
        message: 'A Handoff is final per attempt; a different one needs a new attempt.',
      })
    }
    if (!parsed.data.met || parsed.data.openItems.length > 0) {
      return refuse('done_condition_unmet')
    }
    try {
      const after = requiresSeal(quest)
        ? await this.deps.quests.submitForSeal(guild, quest.id, lease.attempt)
        : await this.deps.quests.complete(guild, quest.id, lease.attempt)
      return ok({ state: after.state, handoffHash: stored.hash })
    } catch (error) {
      if (error instanceof QuestError) {
        return refuse(error.code)
      }
      throw error
    }
  }
}
