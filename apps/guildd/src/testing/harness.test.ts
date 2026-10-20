import { expect, test } from 'bun:test'
import { MemorySandboxRunner } from '../adapters/memory-sandbox-runner'
import { createHarness } from './harness'

test('the harness runs sandboxes in memory even when the environment asks for Docker', async () => {
  const previous = process.env.SANDBOX_RUNNER
  process.env.SANDBOX_RUNNER = 'docker'
  try {
    const harness = await createHarness()
    try {
      expect(harness.adapters.sandboxes).toBeInstanceOf(MemorySandboxRunner)
    } finally {
      await harness.close()
    }
  } finally {
    if (previous === undefined) {
      delete process.env.SANDBOX_RUNNER
    } else {
      process.env.SANDBOX_RUNNER = previous
    }
  }
})
