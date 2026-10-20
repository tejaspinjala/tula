import type {
  NewResearchCall,
  ResearchCall,
  ResearchStore,
  ReserveResult,
} from '../ports/research-store'

/**
 * Memory adapter for {@link ResearchStore}: state in this instance only; `reserve` checks and
 * writes with no await between, so same-tick callers cannot exceed the cap.
 */
export class MemoryResearchStore implements ResearchStore {
  private readonly guilds = new Map<string, Map<string, ResearchCall>>()

  private calls(guildId: string): Map<string, ResearchCall> {
    let all = this.guilds.get(guildId)
    if (!all) {
      all = new Map()
      this.guilds.set(guildId, all)
    }
    return all
  }

  async reserve(guildId: string, input: NewResearchCall): Promise<ReserveResult> {
    const all = this.calls(guildId)
    const held = [...all.values()].filter((c) => c.questId === input.questId).length
    if (held >= input.maxPerQuest) {
      return { ok: false, error: 'research_cap' }
    }
    const call: ResearchCall = {
      id: crypto.randomUUID(),
      hallId: input.hallId,
      questId: input.questId,
      memberId: input.memberId,
    }
    all.set(call.id, call)
    return { ok: true, call }
  }

  async release(guildId: string, callId: string): Promise<void> {
    this.calls(guildId).delete(callId)
  }

  async count(guildId: string, questId: string): Promise<number> {
    return [...this.calls(guildId).values()].filter((c) => c.questId === questId).length
  }
}
