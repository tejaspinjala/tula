import { afterAll, beforeAll } from 'bun:test'
import { DockerSandboxRunner } from '../src/adapters/docker-sandbox-runner'
import { sandboxRunnerContract } from '../src/ports/sandbox-runner.contract'
import { PINNED_BUN_IMAGE } from '../src/sandbox-spec'
import { TestNetworks } from './docker-fixture'

const networks = new TestNetworks()
beforeAll(() => networks.create())
afterAll(() => networks.cleanup())

/** A Docker runner in its own scope (so `kill("all")` sees only its sandboxes), idle, labelled for cleanup. */
function idleRunner(): DockerSandboxRunner {
  return new DockerSandboxRunner({
    image: PINNED_BUN_IMAGE,
    network: networks.sandbox,
    scope: `${networks.tag}-${crypto.randomUUID().slice(0, 6)}`,
    command: ['sleep', '300'],
    extraLabels: { 'guildhall.test': networks.tag },
  })
}

sandboxRunnerContract('docker', async () => idleRunner())
