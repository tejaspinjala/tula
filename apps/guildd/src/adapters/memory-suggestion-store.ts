import type { Clock } from '../ports/clock'
import type {
  DecideResult,
  NewSuggestion,
  Suggestion,
  SuggestionPage,
  SuggestionStatus,
  SuggestionStore,
} from '../ports/suggestion-store'

/**
 * Memory adapter for {@link SuggestionStore}: state in this instance only. Every check and the
 * write it guards run synchronously, so same-tick calls cannot interleave.
 */
export class MemorySuggestionStore implements SuggestionStore {
  /** Per guild: suggestions keyed by id, and the source ids already taken. */
  private readonly guilds = new Map<string, Map<string, Suggestion>>()

  constructor(private readonly clock: Clock) {}

  private ofGuild(guildId: string): Map<string, Suggestion> {
    let found = this.guilds.get(guildId)
    if (!found) {
      found = new Map()
      this.guilds.set(guildId, found)
    }
    return found
  }

  async addMany(guildId: string, items: readonly NewSuggestion[]): Promise<number> {
    const mine = this.ofGuild(guildId)
    const taken = new Set([...mine.values()].map((s) => s.sourceId))
    const at = this.clock.now().toISOString()
    let added = 0
    for (const item of items) {
      if (taken.has(item.sourceId)) {
        continue
      }
      taken.add(item.sourceId)
      const id = crypto.randomUUID()
      mine.set(id, {
        ...item,
        id,
        status: 'pending',
        noteId: null,
        createdAt: at,
        decidedAt: null,
      })
      added += 1
    }
    return added
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SuggestionStatus }
  ): Promise<SuggestionPage> {
    const matching = [...this.ofGuild(guildId).values()]
      .filter((s) => page.after === undefined || s.id > page.after)
      .filter((s) => page.status === undefined || s.status === page.status)
      .sort((a, b) => (a.id < b.id ? -1 : 1))
    const suggestions = matching.slice(0, page.limit).map((s) => structuredClone(s))
    const last = suggestions.at(-1)
    return { suggestions, next: matching.length > page.limit && last ? last.id : null }
  }

  async get(guildId: string, id: string): Promise<Suggestion | null> {
    const found = this.ofGuild(guildId).get(id)
    return found ? structuredClone(found) : null
  }

  async decide(
    guildId: string,
    id: string,
    status: 'accepted' | 'dismissed'
  ): Promise<DecideResult> {
    const found = this.ofGuild(guildId).get(id)
    if (!found) {
      return { ok: false, reason: 'not_found' }
    }
    if (found.status !== 'pending') {
      return { ok: false, reason: 'already_decided' }
    }
    found.status = status
    found.decidedAt = this.clock.now().toISOString()
    return { ok: true, suggestion: structuredClone(found) }
  }

  async recordNote(guildId: string, id: string, noteId: string): Promise<void> {
    const found = this.ofGuild(guildId).get(id)
    if (found?.status === 'accepted') {
      found.noteId = noteId
    }
  }

  async reopen(guildId: string, id: string): Promise<void> {
    const found = this.ofGuild(guildId).get(id)
    if (found?.status === 'accepted' && found.noteId === null) {
      found.status = 'pending'
      found.decidedAt = null
    }
  }
}
