import { keyProviderContract } from '../ports/key-provider.contract'
import { MemoryKeyProvider } from './memory-key-provider'

keyProviderContract('memory', async () => {
  const master = crypto.getRandomValues(new Uint8Array(32))
  return {
    provider: new MemoryKeyProvider(master),
    reopen: async () => new MemoryKeyProvider(master),
  }
})
