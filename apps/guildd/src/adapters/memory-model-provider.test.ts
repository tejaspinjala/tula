import { expect, test } from 'bun:test'
import { ProviderSecret } from '../ports/model-provider'
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
