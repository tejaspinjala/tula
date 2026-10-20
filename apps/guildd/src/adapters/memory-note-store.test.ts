import { noteStoreContract } from '../ports/note-store.contract'
import { MemoryNoteStore } from './memory-note-store'

noteStoreContract('memory', async () => ({
  store: new MemoryNoteStore(),
  newGuild: async () => crypto.randomUUID(),
}))
