/** How long a stream ticket stays valid. */
export const STREAM_TICKET_TTL_MS = 30_000

/** A freshly issued ticket: the secret to present once, and when it lapses. */
export interface StreamTicket {
  ticket: string
  expiresAt: string
}

/**
 * Port for event-stream tickets: short-lived, single-use, bound to one guild. Only a hash of the
 * ticket is kept, and state lives in the adapter, never in process memory of the app.
 */
export interface StreamTicketStore {
  /** Issues a ticket for `guildId`, valid for {@link STREAM_TICKET_TTL_MS}. */
  issue(guildId: string): Promise<StreamTicket>
  /**
   * Spends `ticket` for `guildId`. True for exactly one of any number of same-moment calls, and only
   * before expiry and only for the guild it was issued to.
   */
  consume(guildId: string, ticket: string): Promise<boolean>
}
