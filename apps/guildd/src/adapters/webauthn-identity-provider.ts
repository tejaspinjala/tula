import { timingSafeEqual } from 'node:crypto'
import {
  type AuthenticationResponseJSON,
  generateAuthenticationOptions,
  generateRegistrationOptions,
  type RegistrationResponseJSON,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import type { Clock } from '../ports/clock'
import {
  CHALLENGE_TTL_MS,
  FOUNDING_TTL_MS,
  IdentityError,
  type IdentityProvider,
  type IdentitySession,
  REAUTH_TTL_MS,
  type ReauthProof,
  SESSION_TTL_MS,
} from '../ports/identity'
import type {
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredSession,
} from './identity-store'

/** Relying-party settings and collaborators for the embedded WebAuthn core. */
export interface WebAuthnIdentityConfig {
  clock: Clock
  /** Relying-party id: the registrable domain the passkeys are scoped to. */
  rpId: string
  rpName: string
  /** The exact origin the ledger view is served from. */
  origin: string
}

const guildPrefix = z.uuid()

function randomToken(): string {
  return isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32)))
}

async function hashOf(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return isoBase64URL.fromBuffer(new Uint8Array(digest))
}

/**
 * Embedded adapter for {@link IdentityProvider} (ADR-0007): verifies WebAuthn itself with
 * `@simplewebauthn/server` over an {@link IdentityStore}. Session tokens are
 * `<guild id>.<random>` so the store lookup is tenant-scoped; only their hash is stored.
 */
export class WebAuthnIdentityProvider implements IdentityProvider {
  constructor(
    private readonly store: IdentityStore,
    private readonly config: WebAuthnIdentityConfig
  ) {}

  async hasCredentials(guildId: string): Promise<boolean> {
    return (await this.store.listCredentials(guildId)).length > 0
  }

  async issueFoundingToken(guildId: string) {
    const token = randomToken()
    const expiresAt = new Date(this.config.clock.now().getTime() + FOUNDING_TTL_MS)
    await this.store.issueFounding(guildId, await hashOf(token), expiresAt)
    return { token, expiresAt }
  }

  async beginRegistration(
    guildId: string,
    auth: { sessionToken?: string; foundingToken?: string } = {}
  ) {
    const existing = await this.store.listCredentials(guildId)
    let sessionId: string | null = null
    let foundingHash: string | null = null
    if (existing.length > 0) {
      const live = auth.sessionToken ? await this.liveSession(auth.sessionToken) : null
      if (live?.guildId !== guildId) {
        throw new IdentityError('registration_closed')
      }
      sessionId = live.session.id
    } else {
      foundingHash = auth.foundingToken ? await hashOf(auth.foundingToken) : null
      const now = this.config.clock.now()
      if (!foundingHash || !(await this.store.hasFounding(guildId, foundingHash, now))) {
        throw new IdentityError('registration_closed')
      }
    }
    const options = await generateRegistrationOptions({
      rpID: this.config.rpId,
      rpName: this.config.rpName,
      userName: 'guild-master',
      userDisplayName: 'Guild Master',
      userID: new TextEncoder().encode(guildId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
    })
    const challengeId = await this.saveChallenge(
      guildId,
      'register',
      options.challenge,
      sessionId,
      foundingHash
    )
    return { challengeId, options }
  }

  async finishRegistration(
    guildId: string,
    challengeId: string,
    response: RegistrationResponseJSON,
    auth: { sessionToken?: string } = {}
  ) {
    const challenge = await this.takeChallenge(guildId, challengeId, 'register')
    if (!challenge.foundingHash) {
      const live = auth.sessionToken ? await this.liveSession(auth.sessionToken) : null
      if (live?.guildId !== guildId || live.session.id !== challenge.sessionId) {
        throw new IdentityError('registration_closed')
      }
    }
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: true,
    }).catch(() => null)
    if (!verified?.verified) {
      throw new IdentityError('verification_failed')
    }
    const { credential } = verified.registrationInfo
    const stored: StoredCredential = {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    }
    if (challenge.foundingHash) {
      const founded = await this.store.foundCredential(
        guildId,
        stored,
        challenge.foundingHash,
        this.config.clock.now()
      )
      if (!founded) {
        throw new IdentityError('registration_closed')
      }
    } else {
      await this.store.saveCredential(guildId, stored)
    }
    return { credentialId: credential.id }
  }

  async beginSignIn(guildId: string) {
    const options = await this.requestOptions(guildId)
    const challengeId = await this.saveChallenge(guildId, 'signin', options.challenge, null)
    return { challengeId, options }
  }

  async finishSignIn(
    guildId: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<IdentitySession> {
    const challenge = await this.takeChallenge(guildId, challengeId, 'signin')
    await this.verifyAssertion(guildId, challenge, response)
    const token = `${guildId}.${randomToken()}`
    const expiresAt = new Date(this.config.clock.now().getTime() + SESSION_TTL_MS)
    await this.store.saveSession(guildId, {
      id: crypto.randomUUID(),
      tokenHash: await hashOf(token),
      expiresAt,
      reauthHash: null,
      reauthExpiresAt: null,
    })
    return { token, guildId, expiresAt }
  }

  async beginReauth(sessionToken: string) {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      throw new IdentityError('unauthenticated')
    }
    const options = await this.requestOptions(live.guildId)
    const challengeId = await this.saveChallenge(
      live.guildId,
      'reauth',
      options.challenge,
      live.session.id
    )
    return { challengeId, options }
  }

  async finishReauth(
    sessionToken: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<ReauthProof> {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      throw new IdentityError('unauthenticated')
    }
    const challenge = await this.takeChallenge(live.guildId, challengeId, 'reauth')
    if (challenge.sessionId !== live.session.id) {
      throw new IdentityError('invalid_challenge')
    }
    await this.verifyAssertion(live.guildId, challenge, response)
    const proof = randomToken()
    const expiresAt = new Date(this.config.clock.now().getTime() + REAUTH_TTL_MS)
    await this.store.setReauth(live.guildId, live.session.id, await hashOf(proof), expiresAt)
    return { proof, expiresAt }
  }

  async resolveSession(sessionToken: string): Promise<{ guildId: string } | null> {
    const live = await this.liveSession(sessionToken)
    return live ? { guildId: live.guildId } : null
  }

  async checkReauth(sessionToken: string, proof: string): Promise<boolean> {
    const live = await this.liveSession(sessionToken)
    return live ? this.proofMatches(live.session, proof) : false
  }

  async consumeReauth(sessionToken: string, proof: string): Promise<boolean> {
    const live = await this.liveSession(sessionToken)
    if (!live?.session.reauthHash || !(await this.proofMatches(live.session, proof))) {
      return false
    }
    return this.store.clearReauth(live.guildId, live.session.id, live.session.reauthHash)
  }

  private async proofMatches(session: StoredSession, proof: string): Promise<boolean> {
    const { reauthHash, reauthExpiresAt } = session
    if (!reauthHash || !reauthExpiresAt || reauthExpiresAt <= this.config.clock.now()) {
      return false
    }
    const expected = Buffer.from(reauthHash)
    const given = Buffer.from(await hashOf(proof))
    return expected.length === given.length && timingSafeEqual(expected, given)
  }

  private async liveSession(token: string) {
    const guildId = guildPrefix.safeParse(token.split('.')[0])
    if (!guildId.success) {
      return null
    }
    const session = await this.store.findSession(guildId.data, await hashOf(token))
    if (!session || session.expiresAt <= this.config.clock.now()) {
      return null
    }
    return { guildId: guildId.data, session }
  }

  private async requestOptions(guildId: string) {
    const credentials = await this.store.listCredentials(guildId)
    return generateAuthenticationOptions({
      rpID: this.config.rpId,
      userVerification: 'required',
      allowCredentials: credentials.map((c) => ({ id: c.id, transports: c.transports })),
    })
  }

  private async saveChallenge(
    guildId: string,
    kind: StoredChallenge['kind'],
    challenge: string,
    sessionId: string | null,
    foundingHash: string | null = null
  ): Promise<string> {
    const id = crypto.randomUUID()
    const now = this.config.clock.now()
    await this.store.saveChallenge(
      guildId,
      {
        id,
        kind,
        challenge,
        sessionId,
        foundingHash,
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      },
      now
    )
    return id
  }

  private async takeChallenge(
    guildId: string,
    id: string,
    kind: StoredChallenge['kind']
  ): Promise<StoredChallenge> {
    const challenge = z.uuid().safeParse(id).success
      ? await this.store.takeChallenge(guildId, id)
      : null
    if (!challenge || challenge.kind !== kind || challenge.expiresAt <= this.config.clock.now()) {
      throw new IdentityError('invalid_challenge')
    }
    return challenge
  }

  private async verifyAssertion(
    guildId: string,
    challenge: StoredChallenge,
    response: AuthenticationResponseJSON
  ): Promise<void> {
    const credentials = await this.store.listCredentials(guildId)
    const credential: StoredCredential | undefined = credentials.find((c) => c.id === response.id)
    if (!credential) {
      throw new IdentityError('unknown_credential')
    }
    const verified = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: this.config.origin,
      expectedRPID: this.config.rpId,
      requireUserVerification: true,
      credential: {
        id: credential.id,
        publicKey: credential.publicKey,
        counter: credential.counter,
      },
    }).catch(() => null)
    if (!verified?.verified) {
      throw new IdentityError('verification_failed')
    }
    await this.store.updateCounter(guildId, credential.id, verified.authenticationInfo.newCounter)
  }
}
