import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { ActivityLog, NewActivity } from '../ports/activity-log'
import type { KeyProvider } from '../ports/key-provider'

/**
 * Postgres {@link ActivityLog}: one upsert per call in `Db.withGuild`, so RLS scopes it to one
 * guild. The upsert only writes (and so only returns a row) when no event of this Member and
 * activity fell inside the window; the row lock makes concurrent calls agree. The
 * `member.activity` event (ids and the enum only) is appended in the same transaction.
 */
export class PgActivityLog implements ActivityLog {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async record(guildId: string, input: NewActivity): Promise<{ emitted: boolean }> {
    return this.db.withGuild(guildId, async (tx) => {
      const won = await tx`
        insert into member_activity (guild_id, member_id, activity, last_at)
        values (${guildId}, ${input.memberId}, ${input.activity}, ${input.at})
        on conflict (guild_id, member_id, activity) do update set last_at = excluded.last_at
          where member_activity.last_at <= excluded.last_at - ${input.windowMs} * interval '1 millisecond'
        returning 1 as won`
      if (won.length === 0) {
        return { emitted: false }
      }
      await appendEvent(tx, this.keys, 'member.activity', {
        questId: input.questId,
        memberId: input.memberId,
        hallId: input.hallId,
        activity: input.activity,
        ...(input.peerHallId === undefined ? {} : { peerHallId: input.peerHallId }),
      })
      return { emitted: true }
    })
  }
}
