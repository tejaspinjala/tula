import { expect, test } from 'bun:test'
import { type ModelProvider, ProviderSecret } from '../ports/model-provider'
import { modelProviderContract } from '../ports/model-provider.contract'
import { MemoryModelProvider } from './memory-model-provider'

modelProviderContract('memory', async () => {
  const provider = new MemoryModelProvider()
  return {
    provider,
    script: (r) => provider.script(r),
    backendCalls: () => provider.seen.length,
  }
})

test('an unscripted call is unavailable', async () => {
  const p = new MemoryModelProvider()
  await expect(
    p.complete(new ProviderSecret('k'), {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      maxTokens: 1,
    })
  ).rejects.toMatchObject({ code: 'unavailable' })
})

test('an aborted signal rejects as aborted and never reaches the backend', async () => {
  const memory = new MemoryModelProvider()
  memory.script({ ok: true, text: 'x', usage: { inputTokens: 1, outputTokens: 1 } })
  const p: ModelProvider = memory
  const controller = new AbortController()
  controller.abort()
  await expect(
    p.complete(
      new ProviderSecret('k'),
      { model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 1 },
      controller.signal
    )
  ).rejects.toMatchObject({ code: 'aborted' })
  expect(memory.seen).toHaveLength(0)
})
