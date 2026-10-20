import { secretStoreContract } from '../ports/secret-store.contract'
import { MemoryKeyProvider } from './memory-key-provider'
import { MemorySecretStore } from './memory-secret-store'

secretStoreContract('memory', async () => {
  const store = new MemorySecretStore(new MemoryKeyProvider())
  return { store, newGuild: async () => crypto.randomUUID(), stored: (g, r) => store.stored(g, r) }
})
