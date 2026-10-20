import { guildMasterLookStoreContract } from '../ports/guild-master-look-store.contract'
import { MemoryGuildMasterLookStore } from './memory-guild-master-look-store'

guildMasterLookStoreContract('memory', async () => ({
  store: new MemoryGuildMasterLookStore(),
  newGuild: async () => crypto.randomUUID(),
}))
