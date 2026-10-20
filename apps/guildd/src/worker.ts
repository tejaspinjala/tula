import { z } from 'zod'

/** The slice of `fetch` the worker needs; a seam for tests. */
export type WorkerFetch = (url: string, init: RequestInit) => Promise<Response>

/** What a sandboxed worker is given: its per-run token and lease handle, and where the gateways are. */
export interface WorkerInput {
  /** Origin of the model gateway and the MCP gateway, reached through the egress proxy. */
  gatewayUrl: string
  /** The per-run model gateway token. */
  runToken: string
  /** The lease handle (JSON): Quest id, attempt and the signed lease. */
  leaseHandle: string
  /** The Quest's done-condition. */
  doneCondition: string
  fetch: WorkerFetch
}

const REQUEST_TIMEOUT_MS = 60_000
const leaseHandle = z.object({ questId: z.string(), attempt: z.number(), token: z.string() })
const modelAnswer = z.object({ text: z.string() })
const toolReply = z.object({
  result: z
    .object({
      isError: z.boolean().optional(),
      structuredContent: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
  error: z.object({ message: z.string() }).optional(),
})

/** Why a worker step failed; coded, never the gateway's text. */
export class WorkerError extends Error {
  constructor(
    readonly step:
      | 'read_brief'
      | 'model_call'
      | 'put_artifact'
      | 'submit_proposal'
      | 'complete_quest'
  ) {
    super(`worker_failed:${step}`)
    this.name = 'WorkerError'
  }
}

/**
 * Reads the Quest's Brief with its lease (`read_brief`), then runs the test Quest of "Summon your
 * first member" as a Member would: one model call through the model gateway, the answer filed as an artifact (and, on a Quest that needs a Seal, as a Proposal through `submit_proposal`) and the Quest completed with a Handoff, all
 * through the MCP gateway. Holds no provider key. Throws a {@link WorkerError} when a step is refused.
 */
export async function runWorker(input: WorkerInput): Promise<void> {
  const lease = leaseHandle.parse(JSON.parse(input.leaseHandle))
  const post = (path: string, headers: Record<string, string>, body: unknown) =>
    input.fetch(new URL(path, input.gatewayUrl).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })

  let rpcId = 0
  const tool = async (
    name: string,
    args: object,
    step: 'read_brief' | 'put_artifact' | 'submit_proposal' | 'complete_quest'
  ) => {
    rpcId += 1
    const res = await post(
      '/mcp',
      {},
      { jsonrpc: '2.0', id: rpcId, method: 'tools/call', params: { name, arguments: args } }
    )
    const reply = toolReply.parse(await res.json())
    if (!res.ok || reply.error || reply.result?.isError) {
      throw new WorkerError(step)
    }
    return reply.result?.structuredContent ?? {}
  }

  const { brief, requiresSeal } = z
    .object({ brief: z.string(), requiresSeal: z.boolean().default(false) })
    .parse(await tool('read_brief', { lease }, 'read_brief'))

  const model = await post(
    '/gateway/complete',
    { authorization: `Bearer ${input.runToken}` },
    {
      messages: [
        { role: 'user', content: `${brief}\nReply with one short sentence saying you are ready.` },
      ],
      maxTokens: 64,
    }
  )
  if (!model.ok) {
    throw new WorkerError('model_call')
  }
  const { text } = modelAnswer.parse(await model.json())

  const put = await tool(
    'put_artifact',
    { lease, contentBase64: Buffer.from(text, 'utf8').toString('base64') },
    'put_artifact'
  )
  const hash = z.string().parse(put.hash)
  if (requiresSeal) {
    // The final draft becomes a Proposal (and meets its Verdict) before the Quest asks for a Seal.
    await tool('submit_proposal', { lease, text, evidenceLinks: [] }, 'submit_proposal')
  }
  await tool(
    'complete_quest',
    {
      lease,
      handoff: {
        goal: 'Prove the worker runs a Quest end to end',
        doneCondition: input.doneCondition,
        met: true,
        evidence: [{ kind: 'artifact', ref: hash }],
        openItems: [],
        artifacts: [hash],
      },
    },
    'complete_quest'
  )
}
