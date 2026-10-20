import { createHash, randomBytes } from 'node:crypto'
import type { Clock } from '../ports/clock'
import {
  STREAM_TICKET_TTL_MS,
  type StreamTicket,
  type StreamTicketStore,
} from '../ports/stream-ticket'

/** Hex SHA-256 of a ticket: the only form the stores keep. */
export function hashTicket(ticket: string): string {
  return createHash('sha256').update(ticket).digest('hex')
}

/** A fresh unguessable ticket. */
export function newTicket(): string {
  return randomBytes(32).toString('base64url')
}

/** Memory {@link StreamTicketStore}: consume checks and deletes with no `await` between, so it is atomic. */
export class MemoryStreamTicketStore implements StreamTicketStore {
  private readonly tickets = new Map<string, number>()

  constructor(private readonly clock: Clock) {}

  async issue(guildId: string): Promise<StreamTicket> {
    const ticket = newTicket()
    const expires = this.clock.now().getTime() + STREAM_TICKET_TTL_MS
    this.tickets.set(`${guildId}:${hashTicket(ticket)}`, expires)
    return { ticket, expiresAt: new Date(expires).toISOString() }
  }

  async consume(guildId: string, ticket: string): Promise<boolean> {
    const key = `${guildId}:${hashTicket(ticket)}`
    const expires = this.tickets.get(key)
    if (expires === undefined) {
      return false
    }
    this.tickets.delete(key)
    return expires > this.clock.now().getTime()
  }
}
