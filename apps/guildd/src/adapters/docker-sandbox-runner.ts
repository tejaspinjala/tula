import type { KillTarget, Sandbox, SandboxRunner, SandboxSpec } from '../ports/sandbox-runner'
import { hardenedRunArgs, type SandboxLimits } from '../sandbox-spec'

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
  /**
   * Overall deadline for `kill`, in ms, below the per-call timeout. Defaults to 2000. A kill that
   * rejects at the deadline (`kill_failed`, surfaced as `killFailed` by Bar the Gates) means the
   * kill was not confirmed within the deadline, not that nothing was killed.
   */
  killDeadlineMs?: number
  /** Longest any one docker call may take, in ms. Defaults to 10000. */
  timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_KILL_DEADLINE_MS = 2_000
const DEFAULT_LIMITS: SandboxLimits = { pids: 256, memory: '1g', cpus: '1' }

/** Why a docker call failed; coded, never docker's own text (it could echo the environment). */
export class SandboxError extends Error {
  constructor(readonly code: 'start_failed' | 'kill_failed' | 'list_failed' | 'invalid_env') {
    super(code)
    this.name = 'SandboxError'
  }
}

/** The real `docker` CLI, with a hard timeout. */
export const spawnDocker: DockerExec = async (args, { stdin, timeoutMs }) => {
  const proc = Bun.spawn(['docker', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, stdout: stdout.trim(), stderr: stderr.trim() }
}

const SCOPE_LABEL = 'guildhall.scope'
const GUILD_LABEL = 'guildhall.guild'
const QUEST_LABEL = 'guildhall.quest'
const SANDBOX_LABEL = 'guildhall.sandbox'

/**
 * {@link SandboxRunner} over the Docker CLI: one hardened container per sandbox (see
 * {@link hardenedRunArgs}), labelled with its scope, guild, Quest and sandbox ids so `kill` finds
 * it by label alone, with no state in this process. The sandbox gets only its per-run token and
 * lease handle, through an env file on stdin: never a provider key, never a Vault handle.
 */
export class DockerSandboxRunner implements SandboxRunner {
  private readonly exec: DockerExec
  private readonly timeoutMs: number

  constructor(private readonly options: DockerSandboxOptions) {
    this.exec = options.exec ?? spawnDocker
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  }

  async start(guildId: string, spec: SandboxSpec): Promise<Sandbox> {
    const sandboxId = `gh-sbx-${crypto.randomUUID()}`
    const env: Record<string, string> = {
      ...this.options.env,
      GUILDHALL_QUEST_ID: spec.questId,
      ...(spec.runToken === undefined ? {} : { GUILDHALL_RUN_TOKEN: spec.runToken }),
      ...(spec.leaseHandle === undefined ? {} : { GUILDHALL_LEASE_HANDLE: spec.leaseHandle }),
      ...(spec.doneCondition === undefined ? {} : { GUILDHALL_DONE_CONDITION: spec.doneCondition }),
    }
    if (Object.values(env).some((v) => /[\r\n]/.test(v))) {
      throw new SandboxError('invalid_env')
    }
    const args = hardenedRunArgs({
      image: this.options.image,
      name: sandboxId,
      network: this.options.network,
      labels: {
        ...this.options.extraLabels,
        [SCOPE_LABEL]: this.options.scope,
        [GUILD_LABEL]: guildId,
        [QUEST_LABEL]: spec.questId,
        [SANDBOX_LABEL]: sandboxId,
      },
      limits: this.options.limits ?? DEFAULT_LIMITS,
      command: this.options.command ?? [],
    })
    const stdin = `${Object.entries(env)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n')}\n`
    const run = await this.exec(args, { stdin, timeoutMs: this.timeoutMs })
    if (run.code !== 0) {
      throw new SandboxError('start_failed')
    }
    return { sandboxId, guildId, questId: spec.questId }
  }

  async kill(target: KillTarget): Promise<number> {
    // An overall deadline below the per-call timeouts: Bar the Gates must not wait on a stuck docker.
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new SandboxError('kill_failed')),
        this.options.killDeadlineMs ?? DEFAULT_KILL_DEADLINE_MS
      )
    })
    try {
      return await Promise.race([this.killNow(target), deadline])
    } finally {
      clearTimeout(timer)
    }
  }

  private async killNow(target: KillTarget): Promise<number> {
    const ids = await this.containers(target)
    if (ids.length === 0) {
      return 0
    }
    // `rm -f` is SIGKILL then remove: no grace period, and a container already gone is not an error.
    await this.exec(['rm', '--force', '--volumes', ...ids], { timeoutMs: this.timeoutMs })
    if ((await this.containers(target)).length > 0) {
      throw new SandboxError('kill_failed')
    }
    return ids.length
  }

  async list(guildId: string): Promise<Sandbox[]> {
    const listed = await this.exec(
      [
        'ps',
        '--filter',
        `label=${SCOPE_LABEL}=${this.options.scope}`,
        '--filter',
        `label=${GUILD_LABEL}=${guildId}`,
        '--format',
        `{{.Label "${SANDBOX_LABEL}"}}\t{{.Label "${QUEST_LABEL}"}}`,
      ],
      { timeoutMs: this.timeoutMs }
    )
    if (listed.code !== 0) {
      throw new SandboxError('list_failed')
    }
    return listed.stdout === ''
      ? []
      : listed.stdout.split('\n').map((line) => {
          const [sandboxId = '', questId = ''] = line.split('\t')
          return { sandboxId, guildId, questId }
        })
  }

  /** Container ids of the target in this scope, running or not. */
  private async containers(target: KillTarget): Promise<string[]> {
    const found = await this.exec(
      [
        'ps',
        '--all',
        '--quiet',
        '--no-trunc',
        '--filter',
        `label=${SCOPE_LABEL}=${this.options.scope}`,
        ...(target === 'all' ? [] : ['--filter', `label=${GUILD_LABEL}=${target.guildId}`]),
        ...(target !== 'all' && target.questId !== undefined
          ? ['--filter', `label=${QUEST_LABEL}=${target.questId}`]
          : []),
        ...(target !== 'all' && target.sandboxId !== undefined
          ? ['--filter', `label=${SANDBOX_LABEL}=${target.sandboxId}`]
          : []),
      ],
      { timeoutMs: this.timeoutMs }
    )
    if (found.code !== 0) {
      throw new SandboxError('list_failed')
    }
    return found.stdout === '' ? [] : found.stdout.split('\n')
  }
}
