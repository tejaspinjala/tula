import { questQueueContract } from '../ports/quest-queue.contract'
import { MemoryClock } from './memory-clock'
import { MemoryGateStore } from './memory-gate-store'
import { MemoryQuestQueue } from './memory-quest-queue'
import { MemoryTripwireStore } from './memory-tripwire-store'

questQueueContract('memory', async () => {
  const clock = new MemoryClock(new Date('2030-01-01T00:00:00.000Z'))
  const log: Array<{ guildId: string; type: string }> = []
  const tripwires = new MemoryTripwireStore(clock)
  const gates = new MemoryGateStore()
  return {
    queue: new MemoryQuestQueue(
      clock,
      () => 0.5,
      (guildId, type) => log.push({ guildId, type }),
      (guildId, hallId) => tripwires.pausedNow(guildId, hallId),
      (guildId) => gates.barredNow(guildId)
    ),
    events: async (guildId: string) => log.filter((e) => e.guildId === guildId).map((e) => e.type),
    setHallPaused: async (guildId: string, hallId: string, paused: boolean) => {
      if (paused) {
        await tripwires.pause(guildId, { hallId, tripwire: 'manual', observed: 0, threshold: 0 })
      } else {
        await tripwires.resume(guildId, hallId)
      }
    },
    setBarred: async (guildId: string, scope: 'guild' | 'global', barred: boolean) => {
      const actor = { guildId, memberId: crypto.randomUUID() }
      await (barred ? gates.bar(actor, scope) : gates.lift(actor, scope))
    },
    clock,
    newGuild: async () => crypto.randomUUID(),
  }
})
