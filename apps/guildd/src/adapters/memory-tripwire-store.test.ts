import { tripwireStoreContract } from '../ports/tripwire-store.contract'
import { MemoryClock } from './memory-clock'
import { MemoryTripwireStore } from './memory-tripwire-store'

tripwireStoreContract('memory', async () => {
  const log: Array<{ guildId: string; type: string }> = []
  return {
    store: new MemoryTripwireStore(
      new MemoryClock(new Date('2030-01-01T00:00:00.000Z')),
      (guildId, type) => log.push({ guildId, type })
    ),
    events: async (guildId: string) => log.filter((e) => e.guildId === guildId).map((e) => e.type),
    newGuild: async () => crypto.randomUUID(),
  }
})
