import { routingLogContract } from '../ports/routing-log.contract'
import { MemoryRoutingLog } from './memory-routing-log'

routingLogContract('memory', async () => ({
  log: new MemoryRoutingLog(),
  newGuild: async () => crypto.randomUUID(),
}))
