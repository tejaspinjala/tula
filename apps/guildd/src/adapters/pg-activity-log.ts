import type { Db } from '../db/client'
import type { ActivityLog, NewActivity } from '../ports/activity-log'
import type { KeyProvider } from '../ports/key-provider'

/** Postgres adapter for {@link ActivityLog}: stub, emits everything. */
export class PgActivityLog implements ActivityLog {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async record(_guildId: string, _input: NewActivity): Promise<{ emitted: boolean }> {
    void this.db
    void this.keys
    return { emitted: true }
  }
}
