import { objectStoreContract } from '../ports/object-store.contract'
import { MemoryObjectStore } from './memory-object-store'

objectStoreContract('memory', async () => {
  const store = new MemoryObjectStore()
  return { store, countObjects: async () => store.size }
})
