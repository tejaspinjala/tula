import { afterAll, beforeAll } from 'bun:test'
import { DockerSandboxRunner } from '../src/adapters/docker-sandbox-runner'
import { sandboxRunnerContract } from '../src/ports/sandbox-runner.contract'
import { PINNED_BUN_IMAGE } from '../src/sandbox-spec'
import { TestNetworks } from './docker-fixture'

const networks = new TestNetworks()
beforeAll(() => networks.create())
afterAll(() => networks.cleanup())

/** The Docker runner with an idle command; labelled so cleanup finds what the contract leaves. */
function idleRunner(): DockerSandboxRunner {
  return new DockerSandboxRunner({
    image: PINNED_BUN_IMAGE,
    network: networks.sandbox,
    scope: networks.tag,
    command: ['sleep', '300'],
    extraLabels: { 'guildhall.test': networks.tag },
  })
}

sandboxRunnerContract('docker', async () => idleRunner())
