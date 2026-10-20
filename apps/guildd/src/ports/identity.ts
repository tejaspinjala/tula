import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server'
import { z } from 'zod'
import type { TenantTx } from '../db/client'

/** Why an identity call was refused; never reveals whether a guild exists. */
export type IdentityFailure =
  | 'invalid_challenge'
  | 'verification_failed'
  | 'unknown_credential'
  | 'unauthenticated'
  | 'registration_closed'
  | 'credential_exists'

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

/** How long a founding token stays valid (15 minutes). */
export const FOUNDING_TTL_MS = 15 * 60 * 1000
/** Outstanding ceremony challenges kept per guild and per kind; the oldest of a kind are evicted beyond this. */
export const MAX_OUTSTANDING_CHALLENGES = 20

/**
 * The Guild Master's passkey assertion over a checkpoint: everything needed to re-verify it later
 * against the credential's public key. All fields are base64url.
 */
export const checkpointAssertion = z.object({
  credentialId: z.string().min(1).max(1400),
  authenticatorData: z.string().min(1).max(4096),
  clientDataJSON: z.string().min(1).max(4096),
  signature: z.string().min(1).max(1400),
})

/** See {@link checkpointAssertion}. */
export type CheckpointAssertion = z.infer<typeof checkpointAssertion>

/** A signed-in session, bound to exactly one guild. */
export interface IdentitySession {
  /** Opaque bearer token; the only time it is returned. */
  token: string
  guildId: string
  expiresAt: Date
}

/** Who a session acts as. In this slice the Guild Master is the only human member. */
export interface Principal {
  guildId: string
  memberId: string
  role: 'guild_master'
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
   * Issues the guild's single-use founding token (replacing any earlier one). It is returned once;
   * only its hash is kept. The first passkey of a guild cannot be registered without it.
   * Given the founding transaction `tx`, a database-backed adapter writes inside it so the token
   * commits or rolls back with the guild; the memory adapter has no transaction and ignores it.
   */
  issueFoundingToken(guildId: string, tx?: TenantTx): Promise<{ token: string; expiresAt: Date }>
  /**
   * Starts registering a passkey. A guild with no passkey needs its `foundingToken`; a guild that
   * has one needs a `sessionToken` of that guild. Anything else throws `registration_closed`.
   */
  beginRegistration(
    guildId: string,
    auth?: { sessionToken?: string; foundingToken?: string }
  ): Promise<{ challengeId: string; options: PublicKeyCredentialCreationOptionsJSON }>
  /**
   * Verifies the attestation and stores the passkey; the challenge is consumed either way. A
   * founding challenge succeeds only while the guild still has no passkey (and consumes the
   * founding token in the same step); a session challenge needs the same session again.
   */
  finishRegistration(
    guildId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    auth?: { sessionToken?: string }
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
  /**
   * Starts a usernameless passkey sign-in: options with an empty `allowCredentials` (the
   * authenticator offers its discoverable credentials) and a stored single-use challenge.
   */
  beginDiscoverableSignIn(): Promise<{
    challengeId: string
    options: PublicKeyCredentialRequestOptionsJSON
  }>
  /**
   * Resolves the guild from the asserted credential id, then verifies exactly as {@link finishSignIn}
   * and opens the same session. An unknown credential, a spent challenge and an expired challenge
   * are refused with the same failure shape (`verification_failed` / `invalid_challenge`).
   */
  finishDiscoverableSignIn(
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
  /**
   * Starts the Guild Master's signature over a chain checkpoint: WebAuthn authentication options
   * whose challenge is the 32-byte `checkpointHash` (lowercase hex) followed by a random nonce,
   * kept as a single-use challenge. Throws `unauthenticated` without a live session.
   */
  beginCheckpointSignature(
    sessionToken: string,
    checkpointHash: string
  ): Promise<{ challengeId: string; options: PublicKeyCredentialRequestOptionsJSON }>
  /**
   * Verifies the assertion against the stored passkey and returns it with the checkpoint hash the
   * challenge carried, for the caller to check against the chain and store.
   */
  finishCheckpointSignature(
    sessionToken: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<{ checkpointHash: string; assertion: CheckpointAssertion }>
  /**
   * Re-verifies a stored assertion later, with no challenge store: true only if it is a valid
   * passkey signature by one of `guildId`'s credentials over a challenge that starts with
   * `checkpointHash`. Never touches state.
   */
  verifyCheckpointAssertion(
    guildId: string,
    checkpointHash: string,
    assertion: CheckpointAssertion
  ): Promise<boolean>
  /**
   * The principal a live session acts as (guild, member and the member's server-side role), or
   * null when the session is unknown or expired. The role never comes from the request.
   */
  resolveSession(sessionToken: string): Promise<Principal | null>
  /** Ends the session now (sign-out); its token and any re-authentication proof stop working. Unknown tokens are ignored. */
  revokeSession(sessionToken: string): Promise<void>
  /** A member of the guild with the role the server holds for them, or null. */
  findMember(
    guildId: string,
    memberId: string
  ): Promise<{ memberId: string; role: 'guild_master' } | null>
  /** True only for the current, unexpired proof issued to this live session; does not consume it. */
  checkReauth(sessionToken: string, proof: string): Promise<boolean>
  /** Like `checkReauth`, but a true answer also spends the proof: it works exactly once. */
  consumeReauth(sessionToken: string, proof: string): Promise<boolean>
}
