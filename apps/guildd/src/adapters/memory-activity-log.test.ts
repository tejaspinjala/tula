import { activityLogContract } from '../ports/activity-log.contract'
import { MemoryActivityLog } from './memory-activity-log'

activityLogContract('memory', async () => ({
  log: new MemoryActivityLog(),
  newGuild: async () => crypto.randomUUID(),
}))
