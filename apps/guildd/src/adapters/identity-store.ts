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
  kind: 'register' | 'signin' | 'reauth' | 'checkpoint' | 'enrol'
  /** Base64url challenge handed to the authenticator. */
  challenge: string
  /** The session a re-authentication challenge belongs to. */
  sessionId: string | null
  /** Hash of the founding token (kind `register`) or enrolment token (kind `enrol`) that started the ceremony; null for other kinds. */
  foundingHash: string | null
  expiresAt: Date
}

/** A desktop hand-off code as stored: only hashes of the code and of the shell's state. */
export interface StoredDesktopCode {
  codeHash: string
  stateHash: string
  expiresAt: Date
  /** When the session that minted the code expires; a session the code opens never outlives it. */
  sessionExpiresAt: Date
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
   * changes nothing and appends nothing. Given the founding transaction `tx`, a database-backed
   * adapter writes inside it so the passkey commits or rolls back with the guild.
   */
  saveCredential(
    guildId: string,
    credential: StoredCredential,
    event: IdentityEvent,
    tx?: TenantTx
  ): Promise<void>
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
  /** Stores or replaces the guild's enrolment token hash, appending `event` in the same transaction. */
  issueEnrolment(
    guildId: string,
    tokenHash: string,
    expiresAt: Date,
    event: IdentityEvent
  ): Promise<void>
  /** Whether `tokenHash` is the guild's unexpired enrolment token (not consumed). */
  hasEnrolment(guildId: string, tokenHash: string, now: Date): Promise<boolean>
  /**
   * Atomically spends the unexpired enrolment token `tokenHash` and stores the credential, then
   * appends `events`, all in one transaction.
   * @returns false (changing nothing, appending nothing) when the token is absent, spent or expired.
   */
  enrolCredential(
    guildId: string,
    credential: StoredCredential,
    tokenHash: string,
    now: Date,
    events: IdentityEvent[]
  ): Promise<boolean>
  /**
   * Stores a desktop hand-off code, first deleting the guild's codes that expired at `now` and then
   * evicting the oldest beyond `MAX_OUTSTANDING_DESKTOP_CODES`, appending `event` in the same transaction.
   */
  issueDesktopCode(
    guildId: string,
    code: StoredDesktopCode,
    now: Date,
    event: IdentityEvent
  ): Promise<void>
  /**
   * Atomically spends the unexpired desktop code `codeHash` whose state hash is `stateHash` and
   * appends `event`, in one transaction.
   * @returns the expiry of the session that minted the code, or null (changing nothing, appending
   * nothing) when the code is absent, spent, expired or bound to another state.
   */
  spendDesktopCode(
    guildId: string,
    codeHash: string,
    stateHash: string,
    now: Date,
    event: IdentityEvent
  ): Promise<Date | null>
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
