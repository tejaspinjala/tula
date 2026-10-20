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

/** Builds the hardened `docker run` arguments for one sandbox. */
export function hardenedRunArgs(_spec: HardenedSpec): string[] {
  throw new Error('not implemented')
}
