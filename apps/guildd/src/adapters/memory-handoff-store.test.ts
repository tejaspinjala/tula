import { handoffStoreContract } from '../ports/handoff-store.contract'
import { MemoryHandoffStore } from './memory-handoff-store'

handoffStoreContract('memory', async () => {
  const log: Array<{ guildId: string; type: string; payload: unknown }> = []
  return {
    store: new MemoryHandoffStore((guildId, type, payload) => log.push({ guildId, type, payload })),
    newGuild: async () => crypto.randomUUID(),
    newQuest: async () => crypto.randomUUID(),
    events: async (guildId: string) =>
      log.filter((e) => e.guildId === guildId).map((e) => ({ type: e.type, payload: e.payload })),
  }
})
