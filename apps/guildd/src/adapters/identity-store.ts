import type { TenantTx } from '../db/client'

/**
 * A non-secret audit event an identity action appends with its store write. Payloads carry ids
 * only (credential id, session id), never tokens, proofs, challenges or public keys.
 */
export interface IdentityEvent {
  type: string
  payload: { credentialId?: string; sessionId?: string }
}

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
  kind: 'register' | 'signin' | 'reauth' | 'checkpoint'
  /** Base64url challenge handed to the authenticator. */
  challenge: string
  /** The session a re-authentication challenge belongs to. */
  sessionId: string | null
  /** Hash of the founding token that started a founding registration; null for other kinds. */
  foundingHash: string | null
  expiresAt: Date
}

/** A usernameless sign-in challenge: single-use and held before any guild is known. */
export interface StoredDiscoverableChallenge {
  id: string
  challenge: string
  expiresAt: Date
}

/** A guild member and their server-side role. */
export interface StoredMember {
  memberId: string
  role: 'guild_master'
}

/** A session as stored: the token only as a hash. */
export interface StoredSession {
  id: string
  /** The member the session was opened for; its role is looked up server-side, never stored here. */
  memberId: string
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
  /**
   * Stores a passkey and appends `event` in the same transaction; the same credential id again
   * changes nothing and appends nothing.
   */
  saveCredential(guildId: string, credential: StoredCredential, event: IdentityEvent): Promise<void>
  /** Records the authenticator's latest signature counter. */
  updateCounter(guildId: string, credentialId: string, counter: number): Promise<void>
  /**
   * Stores a challenge, first deleting the guild's challenges that expired at `now` and then
   * evicting the oldest beyond `MAX_OUTSTANDING_CHALLENGES` (ports/identity).
   */
  saveChallenge(guildId: string, challenge: StoredChallenge, now: Date): Promise<void>
  /** Stores or replaces the guild's founding token hash, appending `event` in the same transaction. */
  issueFounding(
    guildId: string,
    tokenHash: string,
    expiresAt: Date,
    event: IdentityEvent,
    tx?: TenantTx
  ): Promise<void>
  /** Whether `tokenHash` is the guild's unexpired founding token (not consumed). */
  hasFounding(guildId: string, tokenHash: string, now: Date): Promise<boolean>
  /**
   * Atomically registers the guild's first passkey: only if the guild still has none and the
   * unexpired founding token `tokenHash` exists, which is spent in the same step.
   * `events` are appended in the same transaction.
   * @returns false (changing nothing, appending nothing) when either condition fails.
   */
  foundCredential(
    guildId: string,
    credential: StoredCredential,
    tokenHash: string,
    now: Date,
    events: IdentityEvent[]
  ): Promise<boolean>
  /**
   * The one guild holding the credential id, or null when none (or, never expected, several) does.
   * Crosses tenants on purpose, through the security-definer `guild_for_credential` (migration 0057).
   */
  guildForCredential(credentialId: string): Promise<string | null>
  /** Stores a usernameless challenge, first deleting those that expired at `now`. */
  saveDiscoverableChallenge(challenge: StoredDiscoverableChallenge, now: Date): Promise<void>
  /** Returns and deletes the usernameless challenge in one step, so it can be used once. */
  takeDiscoverableChallenge(id: string): Promise<StoredDiscoverableChallenge | null>
  /** Clears the session's re-authentication proof if it is still `hash`; false when it was not. */
  clearReauth(guildId: string, sessionId: string, hash: string): Promise<boolean>
  /** Returns and deletes the challenge in one step, so it can be used once. */
  takeChallenge(guildId: string, id: string): Promise<StoredChallenge | null>
  /** The guild's Guild Master, the only human member in this slice; stable for the guild's life. */
  guildMaster(guildId: string): Promise<StoredMember>
  /** A member of the guild with the role the server holds for them, or null. */
  findMember(guildId: string, memberId: string): Promise<StoredMember | null>
  /** Stores a session, appending `event` in the same transaction. */
  saveSession(guildId: string, session: StoredSession, event: IdentityEvent): Promise<void>
  /** Finds a session by the hash of its token. */
  findSession(guildId: string, tokenHash: string): Promise<StoredSession | null>
  /** Ends the session at `at` (expiry set, proof cleared), appending `event` in the same transaction. Unknown ids are ignored. */
  endSession(guildId: string, sessionId: string, at: Date, event: IdentityEvent): Promise<void>
  /** Replaces the session's current re-authentication proof hash, appending `event` in the same transaction. */
  setReauth(
    guildId: string,
    sessionId: string,
    hash: string,
    expiresAt: Date,
    event: IdentityEvent
  ): Promise<void>
}
