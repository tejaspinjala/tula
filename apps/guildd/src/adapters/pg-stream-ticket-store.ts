import type { Db } from '../db/client'
import type { Clock } from '../ports/clock'
import {
  STREAM_TICKET_TTL_MS,
  type StreamTicket,
  type StreamTicketStore,
} from '../ports/stream-ticket'
import { hashTicket, newTicket } from './memory-stream-ticket-store'

/** Postgres {@link StreamTicketStore}: hashes only, consumed by one atomic conditional UPDATE. */
export class PgStreamTicketStore implements StreamTicketStore {
  constructor(
    private readonly db: Db,
    private readonly clock: Clock
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
    return { ticket, expiresAt: expiresAt.toISOString() }
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
