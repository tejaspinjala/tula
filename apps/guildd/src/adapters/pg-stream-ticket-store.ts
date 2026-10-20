import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import {
  STREAM_TICKET_TTL_MS,
  type StreamTicket,
  type StreamTicketStore,
} from '../ports/stream-ticket'
import { hashTicket, newTicket } from './memory-stream-ticket-store'

/** Roughly one issue in this many also deletes the guild's expired tickets. */
const PRUNE_ONE_IN = 20

/** Postgres {@link StreamTicketStore}: hashes only, consumed by one atomic conditional UPDATE. */
export class PgStreamTicketStore implements StreamTicketStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock,
    private readonly random: () => number = Math.random
  ) {}

  async issue(guildId: string): Promise<StreamTicket> {
    const ticket = newTicket()
    const expiresAt = new Date(this.clock.now().getTime() + STREAM_TICKET_TTL_MS)
    await this.db.withGuild(
      guildId,
      (tx) => tx`
        insert into stream_tickets (guild_id, ticket_hash, expires_at)
        values (${guildId}, ${hashTicket(ticket)}, ${expiresAt})`
    )
    if (this.random() < 1 / PRUNE_ONE_IN) {
      // Housekeeping only: a failed prune must not fail an issue that already succeeded.
      await this.prune(guildId).catch(() => undefined)
    }
    return { ticket, expiresAt: expiresAt.toISOString() }
  }

  private async prune(guildId: string): Promise<void> {
    const now = this.clock.now()
    await this.db.withGuild(
      guildId,
      (tx) => tx`delete from stream_tickets where guild_id = ${guildId} and expires_at <= ${now}`
    )
  }

  async consume(guildId: string, ticket: string): Promise<boolean> {
    const now = this.clock.now()
    const rows = await this.db.withGuild(
      guildId,
      (tx) => tx`
        update stream_tickets set consumed_at = ${now}
        where guild_id = ${guildId} and ticket_hash = ${hashTicket(ticket)}
          and consumed_at is null and expires_at > ${now}
        returning 1 as ok`
    )
    return rows.length === 1
  }
}
