import { streamTicketContract } from '../ports/stream-ticket.contract'
import { MemoryClock } from './memory-clock'
import { MemoryStreamTicketStore } from './memory-stream-ticket-store'

streamTicketContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const store = new MemoryStreamTicketStore(clock)
  return {
    store,
    stored: async (guildId: string) => store.count(guildId),
    clock,
    newGuild: async () => crypto.randomUUID(),
  }
})
