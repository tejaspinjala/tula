import { type DockerExec, DockerSandboxRunner } from './adapters/docker-sandbox-runner'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import type { SandboxEnv } from './env'
import type { SandboxRunner } from './ports/sandbox-runner'

/**
 * Builds the sandbox runner the settings ask for: memory for tests and development, otherwise the
 * hardened Docker runner whose sandboxes get the proxy as their only way out and the gateway
 * origin to call through it. `exec` is a seam for tests (the docker CLI).
 */
export function sandboxRunnerFor(env: SandboxEnv, exec?: DockerExec): SandboxRunner {
  if (env.kind === 'memory') {
    return new MemorySandboxRunner()
  }
  return new DockerSandboxRunner({
    image: env.image,
    network: env.network,
    scope: env.scope,
    env: {
      HTTP_PROXY: env.proxyUrl,
      HTTPS_PROXY: env.proxyUrl,
      NO_PROXY: '',
      GUILDHALL_GATEWAY_URL: env.gatewayUrl,
    },
    ...(exec ? { exec } : {}),
  })
}
