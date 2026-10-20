import { z } from 'zod'
import type { Handoff } from '../ports/handoff-store'

/** Sends one JSON-RPC request to the MCP gateway; in-process or over HTTP. */
export type McpTransport = (request: object) => Promise<{ status: number; body: unknown }>

const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.record(z.string(), z.unknown()).optional(),
})
const rpcResponse = z.object({
  result: toolResult.optional(),
  error: z.object({ code: z.number(), message: z.string() }).optional(),
})

/** The outcome of one tool call as a Member sees it. */
export interface ToolOutcome {
  status: number
  /** Set when the call failed at the protocol level (unknown tool, bad lease, bad arguments). */
  rpcError: string | null
  /** True when the tool ran and refused (a tool-level error). */
  isError: boolean
  data: Record<string, unknown>
}

let nextId = 1

/** Calls tool `name` with `args` through `transport` and normalises the answer. */
export async function callTool(
  transport: McpTransport,
  name: string,
  args: object
): Promise<ToolOutcome> {
  nextId += 1
  const { status, body } = await transport({
    jsonrpc: '2.0',
    id: nextId,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const parsed = rpcResponse.parse(body)
  return {
    status,
    rpcError: parsed.error?.message ?? null,
    isError: parsed.result?.isError ?? false,
    data: parsed.result?.structuredContent ?? {},
  }
}

/** What the Member's "thinking" produces: no model, just a fixed answer for the Brief it reads. */
export interface Script {
  /** Given the Brief text, the artifact bytes (as text) to file. */
  output: (brief: string) => string
  goal: string
  openItems?: string[]
  /** Runs once the artifact is filed and before the Quest is completed. */
  afterArtifact?: (artifactHash: string) => Promise<void>
}

/** The result of a full scripted run. */
export interface ScriptedRun {
  brief: string
  lease: { questId: string; attempt: number; token: string }
  artifactHash: string
  handoff: Handoff
  completion: ToolOutcome
}

const claimedData = z.object({
  lease: z.object({ questId: z.string(), attempt: z.number(), token: z.string() }),
  brief: z.string(),
})

/**
 * A scripted Member (memory sandbox, memory model): it makes no model calls. Given an assignment
 * it claims the Quest, reads the Brief, files the scripted output as an artifact, and completes
 * with a Handoff citing that artifact as evidence. Every step goes through the MCP gateway.
 */
export class ScriptedMember {
  constructor(
    private readonly transport: McpTransport,
    private readonly script: Script
  ) {}

  /** Runs claim, read Brief, put artifact, complete with Handoff. @throws Error if a step is refused. */
  async run(assignment: string): Promise<ScriptedRun> {
    const claim = await callTool(this.transport, 'claim_quest', { assignment })
    if (claim.status !== 200 || claim.isError || claim.rpcError) {
      throw new Error(`claim refused: ${claim.rpcError ?? JSON.stringify(claim.data)}`)
    }
    const { lease, brief } = claimedData.parse(claim.data)
    return this.work(lease, brief, false)
  }

  /**
   * Runs read Brief (through `read_brief`, as a real worker does), put artifact, complete for a
   * Quest the dispatcher already claimed: the caller supplies the lease handle from the sandbox
   * spec. @throws Error if a step is refused.
   */
  async runLeased(lease: {
    questId: string
    attempt: number
    token: string
  }): Promise<ScriptedRun> {
    const read = await callTool(this.transport, 'read_brief', { lease })
    if (read.status !== 200 || read.isError || read.rpcError) {
      throw new Error(`read_brief refused: ${read.rpcError ?? JSON.stringify(read.data)}`)
    }
    return this.work(lease, z.string().parse(read.data.brief), read.data.requiresSeal === true)
  }

  private async work(
    lease: { questId: string; attempt: number; token: string },
    brief: string,
    requiresSeal: boolean
  ): Promise<ScriptedRun> {
    const doneCondition = /^Done when: (.+)$/m.exec(brief)?.[1]
    if (!doneCondition) {
      throw new Error('the Brief names no done-condition')
    }
    const output = this.script.output(brief)
    const content = Buffer.from(output, 'utf8').toString('base64')
    const put = await callTool(this.transport, 'put_artifact', { lease, contentBase64: content })
    const artifactHash = z.string().parse(put.data.hash)
    if (requiresSeal) {
      // Like the real worker: the final draft is filed as a Proposal before the Quest is completed.
      const filed = await callTool(this.transport, 'submit_proposal', {
        lease,
        text: output,
        evidenceLinks: [],
      })
      if (filed.status !== 200 || filed.isError || filed.rpcError) {
        throw new Error(`submit_proposal refused: ${filed.rpcError ?? JSON.stringify(filed.data)}`)
      }
    }
    await this.script.afterArtifact?.(artifactHash)
    const handoff: Handoff = {
      goal: this.script.goal,
      doneCondition,
      met: true,
      evidence: [{ kind: 'artifact', ref: artifactHash }],
      openItems: this.script.openItems ?? [],
      artifacts: [artifactHash],
    }
    const completion = await callTool(this.transport, 'complete_quest', { lease, handoff })
    return { brief, lease, artifactHash, handoff, completion }
  }
}
