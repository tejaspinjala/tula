import { gateStoreContract } from '../ports/gate-store.contract'
import { MemoryGateStore } from './memory-gate-store'

gateStoreContract('memory', async () => {
  const log: Array<{ guildId: string; type: string; payload: object }> = []
  return {
    store: new MemoryGateStore((guildId, type, payload) => log.push({ guildId, type, payload })),
    events: async (guildId: string) => log.filter((e) => e.guildId === guildId).map((e) => e.type),
    payload: async (guildId: string, type: string) => {
      const found = log.findLast((e) => e.guildId === guildId && e.type === type)
      return found ? Object.fromEntries(Object.entries(found.payload)) : null
    },
    newGuild: async () => crypto.randomUUID(),
  }
})
