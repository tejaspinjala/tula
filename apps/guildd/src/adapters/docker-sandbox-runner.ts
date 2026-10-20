import type { KillTarget, Sandbox, SandboxRunner, SandboxSpec } from '../ports/sandbox-runner'
import type { SandboxLimits } from '../sandbox-spec'

/** The result of one `docker` invocation. */
export interface DockerResult {
  code: number
  stdout: string
  stderr: string
}

/** Runs `docker` with `args`, feeding `stdin`, giving up after `timeoutMs`. A seam for tests. */
export type DockerExec = (
  args: string[],
  options: { stdin?: string; timeoutMs: number }
) => Promise<DockerResult>

/** Settings of {@link DockerSandboxRunner}. */
export interface DockerSandboxOptions {
  /** Worker image, pinned by digest. */
  image: string
  /** The internal sandbox network; the egress proxy is its only way out. */
  network: string
  /** Separates deployments (and test runs): `kill('all')` only touches containers of this scope. */
  scope: string
  /** The image's command; the image default when omitted. */
  command?: string[]
  limits?: SandboxLimits
  /** Non-secret environment every sandbox gets: the proxy and gateway URLs. */
  env?: Record<string, string>
  exec?: DockerExec
  /** Extra labels on every container (tests use one to find leftovers). */
  extraLabels?: Record<string, string>
  /** Longest any one docker call may take, in ms. Defaults to 10000. */
  timeoutMs?: number
}

/** {@link SandboxRunner} over the Docker CLI: one hardened container per sandbox. */
export class DockerSandboxRunner implements SandboxRunner {
  constructor(private readonly options: DockerSandboxOptions) {}

  async start(_guildId: string, _spec: SandboxSpec): Promise<Sandbox> {
    throw new Error('not implemented')
  }

  async kill(_target: KillTarget): Promise<number> {
    throw new Error('not implemented')
  }

  async list(_guildId: string): Promise<Sandbox[]> {
    throw new Error('not implemented')
  }
}
