import { suggestionStoreContract } from '../ports/suggestion-store.contract'
import { MemoryClock } from './memory-clock'
import { MemorySuggestionStore } from './memory-suggestion-store'

suggestionStoreContract('memory', async () => ({
  store: new MemorySuggestionStore(new MemoryClock(new Date('2026-01-01T00:00:00.000Z'))),
  newGuild: async () => crypto.randomUUID(),
}))
