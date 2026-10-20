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
  IdentityError,
  type IdentityProvider,
  type IdentitySession,
  REAUTH_TTL_MS,
  type ReauthProof,
  SESSION_TTL_MS,
} from '../ports/identity'
import type { IdentityStore, StoredChallenge, StoredCredential } from './identity-store'

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

  async beginRegistration(guildId: string, sessionToken?: string) {
    if (await this.hasCredentials(guildId)) {
      const session = sessionToken ? await this.resolveSession(sessionToken) : null
      if (session?.guildId !== guildId) {
        throw new IdentityError('registration_closed')
      }
    }
    const existing = await this.store.listCredentials(guildId)
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
    const challengeId = await this.saveChallenge(guildId, 'register', options.challenge, null)
    return { challengeId, options }
  }

  async finishRegistration(
    guildId: string,
    challengeId: string,
    response: RegistrationResponseJSON
  ) {
    const challenge = await this.takeChallenge(guildId, challengeId, 'register')
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
    await this.store.saveCredential(guildId, {
      id: credential.id,
      publicKey: new Uint8Array(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports ?? [],
    })
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
    const { reauthHash, reauthExpiresAt } = live?.session ?? {}
    if (!reauthHash || !reauthExpiresAt || reauthExpiresAt <= this.config.clock.now()) {
      return false
    }
    return reauthHash === (await hashOf(proof))
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
    sessionId: string | null
  ): Promise<string> {
    const id = crypto.randomUUID()
    await this.store.saveChallenge(guildId, {
      id,
      kind,
      challenge,
      sessionId,
      expiresAt: new Date(this.config.clock.now().getTime() + CHALLENGE_TTL_MS),
    })
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
