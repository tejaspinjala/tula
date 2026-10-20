import type {
  NewResearchCall,
  ResearchCall,
  ResearchStore,
  ReserveResult,
} from '../ports/research-store'

interface Slot {
  call: ResearchCall
  madeAt: Date
  settled: boolean
}

/**
 * Memory adapter for {@link ResearchStore}: state in this instance only; `reserve` checks and
 * writes with no await between, so same-tick callers cannot exceed the cap.
 */
export class MemoryResearchStore implements ResearchStore {
  private readonly guilds = new Map<string, Map<string, Slot>>()

  private slots(guildId: string): Map<string, Slot> {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = new Map()
      this.guilds.set(guildId, all)
    }
    return all
  }

  async reserve(guildId: string, input: NewResearchCall): Promise<ReserveResult> {
    const all = this.slots(guildId)
    const held = [...all.values()].filter((s) => s.call.questId === input.questId).length
    if (held >= input.maxPerQuest) {
      return { ok: false, error: 'research_cap' }
    }
    const call: ResearchCall = {
      id: crypto.randomUUID(),
      hallId: input.hallId,
      questId: input.questId,
      memberId: input.memberId,
    }
    all.set(call.id, { call, madeAt: input.at, settled: false })
    return { ok: true, call }
  }

  async release(guildId: string, callId: string): Promise<void> {
    this.slots(guildId).delete(callId)
  }

  async count(guildId: string, questId: string): Promise<number> {
    return [...this.slots(guildId).values()].filter((s) => s.call.questId === questId).length
  }

  async settle(guildId: string, callId: string): Promise<void> {
    const slot = this.slots(guildId).get(callId)
    if (slot) {
      slot.settled = true
    }
  }

  async stale(guildId: string, before: Date, limit: number): Promise<string[]> {
    return [...this.slots(guildId).values()]
      .filter((s) => !s.settled && s.madeAt < before)
      .sort((a, b) => a.madeAt.getTime() - b.madeAt.getTime() || (a.call.id < b.call.id ? -1 : 1))
      .slice(0, limit)
      .map((s) => s.call.id)
  }

  async close(guildId: string, callId: string, outcome: 'freed' | 'settled'): Promise<void> {
    const all = this.slots(guildId)
    const slot = all.get(callId)
    if (!slot) {
      return
    }
    if (outcome === 'freed') {
      all.delete(callId)
    } else {
      slot.settled = true
    }
  }
}
