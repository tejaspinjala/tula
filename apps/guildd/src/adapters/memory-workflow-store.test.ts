import { workflowStoreContract } from '../ports/workflow-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryWorkflowStore } from './memory-workflow-store'

workflowStoreContract('memory', async () => ({
  store: new MemoryWorkflowStore(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
  newGuild: async () => crypto.randomUUID(),
}))
