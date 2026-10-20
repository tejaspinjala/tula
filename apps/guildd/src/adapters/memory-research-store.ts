import type {
  NewResearchCall,
  ResearchCall,
  ResearchStore,
  ReserveResult,
} from '../ports/research-store'

interface Slot {
  call: ResearchCall
  madeAt: Date
  spendId: string | null
  settled: boolean
}

/**
 * Memory adapter for {@link ResearchStore}: state in this instance only; `reserve` checks and
 * writes with no await between, so same-tick callers cannot exceed the cap.
 */
export class MemoryResearchStore implements ResearchStore {
  private readonly guilds = new Map<string, Map<string, Slot>>()
  private readonly sweeping = new Set<string>()

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
    all.set(call.id, { call, madeAt: input.at, spendId: null, settled: false })
    return { ok: true, call }
  }

  async release(guildId: string, callId: string): Promise<void> {
    this.slots(guildId).delete(callId)
  }

  async count(guildId: string, questId: string): Promise<number> {
    return [...this.slots(guildId).values()].filter((s) => s.call.questId === questId).length
  }

  async attachSpend(guildId: string, callId: string, spendId: string): Promise<void> {
    const slot = this.slots(guildId).get(callId)
    if (slot) {
      slot.spendId = spendId
    }
  }

  async settle(guildId: string, callId: string): Promise<void> {
    const slot = this.slots(guildId).get(callId)
    if (slot) {
      slot.settled = true
    }
  }

  async sweep(
    guildId: string,
    before: Date,
    releaseSpend: (spendId: string) => Promise<void>
  ): Promise<number> {
    if (this.sweeping.has(guildId)) {
      return 0
    }
    this.sweeping.add(guildId)
    try {
      const all = this.slots(guildId)
      const stale = [...all.values()].filter((s) => !s.settled && s.madeAt < before)
      for (const slot of stale) {
        if (slot.spendId !== null) {
          await releaseSpend(slot.spendId)
        }
        all.delete(slot.call.id)
      }
      return stale.length
    } finally {
      this.sweeping.delete(guildId)
    }
  }
}
