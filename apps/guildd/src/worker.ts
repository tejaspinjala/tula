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

/**
 * Runs the test Quest of "Summon your first member" as a Member would: one model call through the
 * model gateway, the answer filed as an artifact and the Quest completed with a Handoff, all
 * through the MCP gateway. Holds no provider key. Throws when any step is refused.
 */
export async function runWorker(_input: WorkerInput): Promise<void> {
  throw new Error('not implemented')
}
