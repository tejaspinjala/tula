import { describe, expect, test } from 'bun:test'
import { type DockerExec, DockerSandboxRunner } from './docker-sandbox-runner'

/** A docker that never answers. */
const hanging: DockerExec = () => new Promise(() => {})

describe('DockerSandboxRunner.kill deadline', () => {
  test('gives up within its overall deadline when docker hangs, below the per-call timeout', async () => {
    const runner = new DockerSandboxRunner({
      image: `w@sha256:${'a'.repeat(64)}`,
      network: 'n',
      scope: 's',
      exec: hanging,
      timeoutMs: 60_000,
      killDeadlineMs: 150,
    })
    const started = performance.now()
    await expect(runner.kill({ guildId: crypto.randomUUID() })).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
