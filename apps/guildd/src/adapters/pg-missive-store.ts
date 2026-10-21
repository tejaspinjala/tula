import { z } from 'zod'
import type { Db } from '../db/client'
import { appendEvent } from '../events'
import type { KeyProvider } from '../ports/key-provider'
import {
  type Missive,
  type MissivePage,
  type MissiveQuery,
  type MissiveStore,
  type NewMissive,
  type SendResult,
  WHOLE_HALL,
} from '../ports/missive-store'
import { hashBytes } from '../ports/object-store'

const row = z.object({
  missive_id: z.string(),
  seq: z.coerce.number(),
  hall_id: z.string(),
  to_hall: z.string().nullable(),
  quest_id: z.string(),
  sender: z.string(),
  addressee: z.string(),
  body: z.string(),
  sent_at: z.coerce.date(),
})

function toMissive(r: unknown): Missive {
  const m = row.parse(r)
  return {
    seq: m.seq,
    id: m.missive_id,
    hallId: m.hall_id,
    toHall: m.to_hall,
    questId: m.quest_id,
    from: m.sender,
    to: m.addressee,
    text: m.body,
    sentAt: m.sent_at.toISOString(),
  }
}

/**
 * Postgres {@link MissiveStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild.
 * A send takes a per-Quest advisory lock, so the cap and the idempotency check hold under
 * concurrent sends, and appends `missive.sent` (ids only, never the text) in the same transaction.
 */
export class PgMissiveStore implements MissiveStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  async send(guildId: string, input: NewMissive): Promise<SendResult> {
    const dedupe = hashBytes(
      new TextEncoder().encode(
        JSON.stringify([
          input.questId,
          input.attempt,
          input.from,
          input.to,
          input.toHall ?? null,
          input.text,
        ])
      )
    )
    return this.db.withGuild(guildId, async (tx) => {
      await tx`select pg_advisory_xact_lock(hashtextextended(${`missive:${guildId}:${input.questId}`}, 0))`
      const [prior] = await tx`
        select * from missives where guild_id = ${guildId} and dedupe_key = ${dedupe}`
      if (prior) {
        return { ok: true, missive: toMissive(prior), created: false }
      }
      const [count] = await tx`
        select count(*)::int as n from missives
        where guild_id = ${guildId} and quest_id = ${input.questId}`
      if (z.object({ n: z.number() }).parse(count).n >= input.maxPerQuest) {
        return { ok: false, error: 'missive_cap' }
      }
      const [created] = await tx`
        insert into missives (guild_id, hall_id, to_hall, quest_id, sender, addressee, body, sent_at, dedupe_key)
        values (${guildId}, ${input.hallId}, ${input.toHall ?? null}, ${input.questId}, ${input.from}, ${input.to},
          ${input.text}, ${input.at}, ${dedupe})
        returning *`
      const missive = toMissive(created)
      await appendEvent(tx, this.keys, 'missive.sent', {
        missiveId: missive.id,
        from: input.from,
        to: input.to,
        hall: input.hallId,
        ...(input.toHall === undefined ? {} : { toHall: input.toHall }),
      })
      return { ok: true, missive, created: true }
    })
  }

  async list(guildId: string, query: MissiveQuery): Promise<MissivePage> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        select * from missives
        where guild_id = ${guildId} and (hall_id = ${query.hallId} or to_hall = ${query.hallId})
          and (${query.member ?? null}::text is null or sender = ${query.member ?? null}
            or ((to_hall is null or to_hall = ${query.hallId})
              and (addressee = ${query.member ?? null} or addressee = ${WHOLE_HALL})))
          and (${query.since ?? null}::timestamptz is null or sent_at > ${query.since ?? null})
          and (${query.after ?? null}::bigint is null or seq < ${query.after ?? null})
        order by seq desc
        limit ${query.limit + 1}`
    )
    const page = rows.slice(0, query.limit).map(toMissive)
    const last = page.at(-1)
    return { missives: page, next: rows.length > query.limit && last ? last.seq : null }
  }
}
