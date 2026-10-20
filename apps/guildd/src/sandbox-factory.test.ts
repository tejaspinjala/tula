import { describe, expect, test } from 'bun:test'
import { type DockerExec, DockerSandboxRunner } from './adapters/docker-sandbox-runner'
import { MemorySandboxRunner } from './adapters/memory-sandbox-runner'
import { sandboxRunnerFor } from './sandbox-factory'

describe('sandboxRunnerFor', () => {
  test('memory settings give the memory runner', () => {
    expect(sandboxRunnerFor({ kind: 'memory' })).toBeInstanceOf(MemorySandboxRunner)
  })

  test('docker settings give a runner whose sandboxes reach out only through the proxy', async () => {
    const calls: Array<{ args: string[]; stdin: string | undefined }> = []
    const exec: DockerExec = async (args, { stdin }) => {
      calls.push({ args, stdin })
      return { code: 0, stdout: '', stderr: '' }
    }
    const runner = sandboxRunnerFor(
      {
        kind: 'docker',
        image: `worker@sha256:${'b'.repeat(64)}`,
        network: 'guildhall-sandbox',
        scope: 'default',
        proxyUrl: 'http://egress-proxy:3128',
        gatewayUrl: 'http://guildd:3000',
      },
      exec
    )
    expect(runner).toBeInstanceOf(DockerSandboxRunner)
    await runner.start('g1', {
      questId: 'q1',
      runToken: 'tok',
      leaseHandle: 'lease',
      doneCondition: 'It is done',
    })
    const run = calls[0]
    expect(run?.args).toContain(`worker@sha256:${'b'.repeat(64)}`)
    expect(run?.stdin).toContain('HTTPS_PROXY=http://egress-proxy:3128')
    expect(run?.stdin).toContain('HTTP_PROXY=http://egress-proxy:3128')
    expect(run?.stdin).toContain('GUILDHALL_GATEWAY_URL=http://guildd:3000')
    expect(run?.stdin).toContain('GUILDHALL_RUN_TOKEN=tok')
    expect(run?.stdin).toContain('GUILDHALL_DONE_CONDITION=It is done')
    expect(run?.args.join(' ')).not.toContain('tok')
  })
})
