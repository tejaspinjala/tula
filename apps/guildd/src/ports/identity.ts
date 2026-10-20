import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'

/** Why an identity call was refused; never reveals whether a guild exists. */
export type IdentityFailure =
  | 'invalid_challenge'
  | 'verification_failed'
  | 'unknown_credential'
  | 'unauthenticated'
  | 'registration_closed'

/** Thrown by an {@link IdentityProvider} when a ceremony or session check fails. */
export class IdentityError extends Error {
  constructor(readonly code: IdentityFailure) {
    super(code)
    this.name = 'IdentityError'
  }
}

/** How long a session lives (12 hours). */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000
/** How long a re-authentication proof stays valid (5 minutes). */
export const REAUTH_TTL_MS = 5 * 60 * 1000
/** How long a ceremony challenge may wait for its response (5 minutes). */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000

/** A signed-in session, bound to exactly one guild. */
export interface IdentitySession {
  /** Opaque bearer token; the only time it is returned. */
  token: string
  guildId: string
  expiresAt: Date
}

/** Short-lived proof that the Guild Master re-authenticated with the passkey. */
export interface ReauthProof {
  /** Opaque proof, sent with a sensitive action. */
  proof: string
  expiresAt: Date
}

/**
 * Port for the Guild Master's identity (ADR-0007): passkey ceremonies, guild-bound sessions and
 * re-authentication proofs. Every ceremony is a begin/finish pair carrying a one-use challenge.
 */
export interface IdentityProvider {
  /** True once the guild has at least one registered passkey. */
  hasCredentials(guildId: string): Promise<boolean>
  /**
   * Starts registering a passkey. The first passkey of a guild is open (founding); later ones need
   * a session of that guild, else throws `registration_closed`.
   */
  beginRegistration(
    guildId: string,
    sessionToken?: string
  ): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>
  /** Verifies the attestation and stores the passkey; the challenge is consumed either way. */
  finishRegistration(
    guildId: string,
    challengeId: string,
    response: RegistrationResponseJSON
  ): Promise<{ credentialId: string }>
  /** Starts a passkey sign-in for the guild. */
  beginSignIn(
    guildId: string
  ): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>
  /** Verifies the assertion and opens a session bound to `guildId`. */
  finishSignIn(
    guildId: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<IdentitySession>
  /** Starts re-authentication for the session's guild; throws `unauthenticated` without a live session. */
  beginReauth(
    sessionToken: string
  ): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>
  /** Verifies a fresh assertion and issues a short-lived proof tied to that session. */
  finishReauth(
    sessionToken: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<ReauthProof>
  /** The guild a live session is bound to, or null when unknown or expired. */
  resolveSession(sessionToken: string): Promise<{ guildId: string } | null>
  /** True only for the current, unexpired proof issued to this live session. */
  checkReauth(sessionToken: string, proof: string): Promise<boolean>
}
