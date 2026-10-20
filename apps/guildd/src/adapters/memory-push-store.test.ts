import { pushStoreContract } from '../ports/push-store.contract'
import { MemoryPushStore } from './memory-push-store'

pushStoreContract('memory', async () => ({
  store: new MemoryPushStore(),
  newGuild: async () => crypto.randomUUID(),
}))
