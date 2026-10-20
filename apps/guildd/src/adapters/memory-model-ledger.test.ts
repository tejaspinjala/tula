import { modelLedgerContract } from '../ports/model-ledger.contract'
import { MemoryModelLedger } from './memory-model-ledger'

modelLedgerContract('memory', async () => ({
  ledger: new MemoryModelLedger(),
  newGuild: async () => crypto.randomUUID(),
}))
