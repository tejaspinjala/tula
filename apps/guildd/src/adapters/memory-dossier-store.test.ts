import { dossierStoreContract } from '../ports/dossier-store.contract'
import { MemoryDossierStore } from './memory-dossier-store'

dossierStoreContract('memory', async () => ({
  store: new MemoryDossierStore(),
  newGuild: async () => crypto.randomUUID(),
}))
