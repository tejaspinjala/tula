import { gateStoreContract } from '../ports/gate-store.contract'
import { MemoryGateStore } from './memory-gate-store'

gateStoreContract('memory', async () => {
  const log: Array<{ guildId: string; type: string }> = []
  return {
    store: new MemoryGateStore((guildId, type) => log.push({ guildId, type })),
    events: async (guildId: string) => log.filter((e) => e.guildId === guildId).map((e) => e.type),
    newGuild: async () => crypto.randomUUID(),
  }
})
