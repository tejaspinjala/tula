/** A registered passkey as stored. */
export interface StoredCredential {
  /** Base64url credential id. */
  id: string
  publicKey: Uint8Array<ArrayBuffer>
  counter: number
  transports: string[]
}

/** A one-use ceremony challenge awaiting its response. */
export interface StoredChallenge {
  id: string
  kind: 'register' | 'signin' | 'reauth'
  /** Base64url challenge handed to the authenticator. */
  challenge: string
  /** The session a re-authentication challenge belongs to. */
  sessionId: string | null
  /** Hash of the founding token that started a founding registration; null for other kinds. */
  foundingHash: string | null
  expiresAt: Date
}

/** A session as stored: the token only as a hash. */
export interface StoredSession {
  id: string
  tokenHash: string
  expiresAt: Date
  reauthHash: string | null
  reauthExpiresAt: Date | null
}

/**
 * Persistence for the WebAuthn identity core. Every call is scoped to one guild, so a guild's
 * credentials, challenges and sessions can never be reached through another guild's id.
 */
export interface IdentityStore {
  /** All passkeys of the guild. */
  listCredentials(guildId: string): Promise<StoredCredential[]>
  /** Stores a passkey; the same credential id again changes nothing. */
  saveCredential(guildId: string, credential: StoredCredential): Promise<void>
  /** Records the authenticator's latest signature counter. */
  updateCounter(guildId: string, credentialId: string, counter: number): Promise<void>
  /**
   * Stores a challenge, first deleting the guild's challenges that expired at `now` and then
   * evicting the oldest beyond `MAX_OUTSTANDING_CHALLENGES` (ports/identity).
   */
  saveChallenge(guildId: string, challenge: StoredChallenge, now: Date): Promise<void>
  /** Stores or replaces the guild's founding token hash. */
  issueFounding(guildId: string, tokenHash: string, expiresAt: Date): Promise<void>
  /** Whether `tokenHash` is the guild's unexpired founding token (not consumed). */
  hasFounding(guildId: string, tokenHash: string, now: Date): Promise<boolean>
  /**
   * Atomically registers the guild's first passkey: only if the guild still has none and the
   * unexpired founding token `tokenHash` exists, which is spent in the same step.
   * @returns false (changing nothing) when either condition fails.
   */
  foundCredential(
    guildId: string,
    credential: StoredCredential,
    tokenHash: string,
    now: Date
  ): Promise<boolean>
  /** Clears the session's re-authentication proof if it is still `hash`; false when it was not. */
  clearReauth(guildId: string, sessionId: string, hash: string): Promise<boolean>
  /** Returns and deletes the challenge in one step, so it can be used once. */
  takeChallenge(guildId: string, id: string): Promise<StoredChallenge | null>
  /** Stores a session. */
  saveSession(guildId: string, session: StoredSession): Promise<void>
  /** Finds a session by the hash of its token. */
  findSession(guildId: string, tokenHash: string): Promise<StoredSession | null>
  /** Replaces the session's current re-authentication proof hash. */
  setReauth(guildId: string, sessionId: string, hash: string, expiresAt: Date): Promise<void>
}
