/** Resource ceilings of one sandbox. */
export interface SandboxLimits {
  /** Most processes. */
  pids: number
  /** Memory ceiling, as Docker writes it (`512m`). */
  memory: string
  /** CPUs, as Docker writes it (`1`). */
  cpus: string
}

/** Everything {@link hardenedRunArgs} turns into a `docker run` command line. */
export interface HardenedSpec {
  /** Image pinned by digest. */
  image: string
  /** Container name. */
  name: string
  /** The sandbox network: internal, with the egress proxy as its only way out. */
  network: string
  /** Labels (guild and run ids) that `kill` finds the container by. */
  labels: Record<string, string>
  limits: SandboxLimits
  /** The image's command; the image default when empty. */
  command: string[]
}

/** The unprivileged uid:gid every sandbox runs as. */
const SANDBOX_USER = '65532:65532'

/**
 * A resolver address that routes nowhere (RFC 5737 TEST-NET-1). Docker's embedded DNS still
 * answers names of containers on the sandbox network (the egress proxy), while every other name
 * has no upstream to ask, so a sandbox cannot resolve or tunnel through DNS.
 */
const DEAD_DNS = '192.0.2.1'

/**
 * Builds the hardened `docker run` arguments for one sandbox: non-root, read-only root, no
 * capabilities, no new privileges, Docker's default seccomp profile, process, memory and cpu
 * limits, one per-run tmpfs and no host mount, the internal sandbox network only, no published
 * port. Secrets never appear here: the environment goes in through `--env-file /dev/stdin`.
 */
export function hardenedRunArgs(spec: HardenedSpec): string[] {
  return [
    'run',
    '--detach',
    '--rm',
    '--name',
    spec.name,
    '--user',
    SANDBOX_USER,
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    String(spec.limits.pids),
    '--memory',
    spec.limits.memory,
    '--memory-swap',
    spec.limits.memory,
    '--cpus',
    spec.limits.cpus,
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,nodev,size=64m',
    '--workdir',
    '/tmp',
    '--network',
    spec.network,
    '--dns',
    DEAD_DNS,
    ...Object.entries(spec.labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--env-file',
    '/dev/stdin',
    spec.image,
    ...spec.command,
  ]
}
