import type { Server } from 'node:http'

/** Settings of the egress proxy. */
export interface EgressProxyOptions {
  /** Hosts a sandbox may reach: the model gateway and the MCP gateway, nothing else. */
  allowedHosts: readonly string[]
  /** Longest an upstream connection may take to open, in ms. */
  connectTimeoutMs?: number
}

/** Builds the allowlisting egress proxy: the only way out of a sandbox. */
export function createEgressProxy(_options: EgressProxyOptions): Server {
  throw new Error('not implemented')
}
