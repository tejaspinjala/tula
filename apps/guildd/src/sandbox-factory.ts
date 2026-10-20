import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import type { SandboxEnv } from './env'
import type { SandboxRunner } from './ports/sandbox-runner'

/** Builds the sandbox runner the settings ask for. `exec` is a seam for tests (the docker CLI). */
export function sandboxRunnerFor(
  _env: SandboxEnv,
  _exec?: import('./adapters/docker-sandbox-runner').DockerExec
): SandboxRunner {
  return new MemorySandboxRunner()
}
