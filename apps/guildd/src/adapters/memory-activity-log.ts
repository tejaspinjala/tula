import type { ActivityLog, NewActivity } from '../ports/activity-log'

/** Memory adapter for {@link ActivityLog}: stub, emits everything. */
export class MemoryActivityLog implements ActivityLog {
  async record(_guildId: string, _input: NewActivity): Promise<{ emitted: boolean }> {
    return { emitted: true }
  }
}
