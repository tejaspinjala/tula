import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import {
  type Handoff,
  type HandoffStore,
  handoff,
  hashHandoff,
  type StoredHandoff,
} from '../ports/handoff-store'
import type { KeyProvider } from '../ports/key-provider'

const row = z.object({ member_id: z.string(), handoff_hash: z.string(), body: handoff })

function toStored(r: unknown): StoredHandoff {
  const parsed = row.parse(r)
  return { handoff: parsed.body, hash: parsed.handoff_hash, memberId: parsed.member_id }
}

/**
 * Postgres {@link HandoffStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild).
 * A Handoff and its event commit together; a repeat insert is a no-op, so retries are safe.
 */
export class PgHandoffStore implements HandoffStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async record(
    guildId: string,
    questId: string,
    attempt: number,
    memberId: string,
    value: Handoff
  ): Promise<{ stored: StoredHandoff; created: boolean }> {
    const hash = hashHandoff(value)
    return this.db.withGuild(guildId, async (tx) => {
      const inserted = await tx`
        insert into handoffs (guild_id, quest_id, attempt, member_id, handoff_hash, body)
        values (${guildId}, ${questId}, ${attempt}, ${memberId}, ${hash}, ${tx.json(value)})
        on conflict (guild_id, quest_id, attempt) do nothing
        returning attempt`
      const created = inserted.length > 0
      if (created) {
        await appendEvent(tx, this.keys, 'handoff.recorded', {
          quest_id: questId,
          attempt,
          handoff_hash: hash,
        })
      }
      const [stored] = await tx`
        select member_id, handoff_hash, body from handoffs
        where guild_id = ${guildId} and quest_id = ${questId} and attempt = ${attempt}`
      return { stored: toStored(stored), created }
    })
  }

  async get(guildId: string, questId: string, attempt: number): Promise<StoredHandoff | null> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select member_id, handoff_hash, body from handoffs
        where guild_id = ${guildId} and quest_id = ${questId} and attempt = ${attempt}`
    )
    return rows[0] ? toStored(rows[0]) : null
  }

  async attach(guildId: string, questId: string, hash: string, size: number): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      const inserted = await tx`
        insert into quest_artifacts (guild_id, quest_id, hash, size)
        values (${guildId}, ${questId}, ${hash}, ${size})
        on conflict (guild_id, quest_id, hash) do nothing
        returning hash`
      if (inserted.length > 0) {
        await appendEvent(tx, this.keys, 'artifact.attached', { quest_id: questId, hash })
      }
    })
  }

  async holds(guildId: string, questId: string, hash: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select 1 from quest_artifacts
        where guild_id = ${guildId} and quest_id = ${questId} and hash = ${hash}`
    )
    return rows.length > 0
  }
}
