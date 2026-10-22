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
import type { TenantTx } from '../db/client'
import type { Clock } from '../ports/clock'
import {
  CHALLENGE_TTL_MS,
  type CheckpointAssertion,
  DESKTOP_CODE_TTL_MS,
  ENROL_TTL_MS,
  FOUNDING_TTL_MS,
  type FoundingWrite,
  IdentityError,
  type IdentityProvider,
  type IdentitySession,
  type Principal,
  REAUTH_TTL_MS,
  type ReauthProof,
  SESSION_TTL_MS,
} from '../ports/identity'
import type { KeyProvider } from '../ports/key-provider'
import { WEBAUTHN_CEREMONY_TIMEOUT_MS } from '../webauthn-timeout'
import type {
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredSession,
} from './identity-store'

/** Relying-party settings and collaborators for the embedded WebAuthn core. */
export interface WebAuthnIdentityConfig {
  clock: Clock
  /** Derives the stable fake credential ids that decoy sign-in options carry for unknown guilds. */
  keys: KeyProvider
  /** Relying-party id: the registrable domain the passkeys are scoped to. */
  rpId: string
  rpName: string
  /** The exact origin the ledger view is served from. */
  origin: string
}

const guildPrefix = z.uuid()

/** Credential id sizes in bytes that real authenticators produce. */
const DECOY_ID_BYTES = [16, 32, 64]
/** Transport sets real registrations produce; empty when the authenticator reports none. */
const DECOY_TRANSPORTS: Array<Array<'internal' | 'hybrid' | 'usb' | 'nfc' | 'ble'>> = [
  [],
  ['internal'],
  ['hybrid', 'internal'],
  ['usb'],
  ['nfc', 'usb'],
  ['ble'],
]

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

  async issueFoundingToken(guildId: string, tx?: TenantTx) {
    const token = randomToken()
    const expiresAt = new Date(this.config.clock.now().getTime() + FOUNDING_TTL_MS)
    await this.store.issueFounding(
      guildId,
      await hashOf(token),
      expiresAt,
      { type: 'identity.founding_token_issued', payload: {} },
      tx
    )
    return { token, expiresAt }
  }

  async issueEnrolmentToken(guildId: string) {
    const token = `${guildId}.${randomToken()}`
    const expiresAt = new Date(this.config.clock.now().getTime() + ENROL_TTL_MS)
    await this.store.issueEnrolment(guildId, await hashOf(token), expiresAt, {
      type: 'identity.enrolment_token_issued',
      payload: {},
    })
    return { token, expiresAt }
  }

  async beginEnrolment(guildId: string, token: string) {
    const hash = await hashOf(token)
    // Wrong, expired, spent and other-guild tokens all land here, with the same refusal.
    if (!(await this.store.hasEnrolment(guildId, hash, this.config.clock.now()))) {
      throw new IdentityError('registration_closed')
    }
    const existing = await this.store.listCredentials(guildId)
    const options = await this.registrationOptions(guildId, existing)
    const challengeId = await this.saveChallenge(guildId, 'enrol', options.challenge, null, hash)
    return { challengeId, options }
  }

  async finishEnrolment(guildId: string, challengeId: string, response: RegistrationResponseJSON) {
    const challenge = await this.takeChallenge(guildId, challengeId, 'enrol')
    if (!challenge.foundingHash) {
      throw new IdentityError('invalid_challenge')
    }
    const stored = await this.verifiedCredential(guildId, challenge.challenge, response)
    try {
      const enrolled = await this.store.enrolCredential(
        guildId,
        stored,
        challenge.foundingHash,
        this.config.clock.now(),
        [
          { type: 'identity.enrolment_token_spent', payload: { credentialId: stored.id } },
          { type: 'identity.passkey_registered', payload: { credentialId: stored.id } },
        ]
      )
      if (!enrolled) {
        throw new IdentityError('registration_closed')
      }
    } catch (error) {
      if (z.object({ code: z.literal('23505') }).safeParse(error).success) {
        throw new IdentityError('credential_exists')
      }
      throw error
    }
    return this.openSession(guildId)
  }

  async beginDesktopHandoff(sessionToken: string, state: string) {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      throw new IdentityError('unauthenticated')
    }
    const now = this.config.clock.now()
    const code = `${live.guildId}.${randomToken()}`
    const expiresAt = new Date(now.getTime() + DESKTOP_CODE_TTL_MS)
    await this.store.issueDesktopCode(
      live.guildId,
      {
        codeHash: await hashOf(code),
        stateHash: await hashOf(state),
        expiresAt,
        sessionExpiresAt: live.session.expiresAt,
      },
      now,
      { type: 'identity.desktop_code_issued', payload: { sessionId: live.session.id } }
    )
    return { code, expiresAt }
  }

  async exchangeDesktopCode(code: string, state: string) {
    const guildId = guildPrefix.safeParse(code.split('.')[0])
    // Malformed, wrong, expired, spent, other-guild and wrong-state all land here, with the same refusal.
    if (!guildId.success) {
      throw new IdentityError('invalid_challenge')
    }
    const sourceExpiry = await this.store.spendDesktopCode(
      guildId.data,
      await hashOf(code),
      await hashOf(state),
      this.config.clock.now(),
      { type: 'identity.desktop_code_spent', payload: {} }
    )
    if (!sourceExpiry) {
      throw new IdentityError('invalid_challenge')
    }
    return this.openSession(guildId.data, sourceExpiry)
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
    const options = await this.registrationOptions(guildId, existing)
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
    const stored = await this.verifiedCredential(guildId, challenge.challenge, response)
    try {
      if (challenge.foundingHash) {
        const founded = await this.store.foundCredential(
          guildId,
          stored,
          challenge.foundingHash,
          this.config.clock.now(),
          [
            { type: 'identity.founding_token_spent', payload: { credentialId: stored.id } },
            { type: 'identity.passkey_registered', payload: { credentialId: stored.id } },
          ]
        )
        if (!founded) {
          throw new IdentityError('registration_closed')
        }
      } else {
        await this.store.saveCredential(guildId, stored, {
          type: 'identity.passkey_registered',
          payload: { credentialId: stored.id },
        })
      }
    } catch (error) {
      // A concurrent registration of the same id lost the unique index race (Postgres 23505).
      if (z.object({ code: z.literal('23505') }).safeParse(error).success) {
        throw new IdentityError('credential_exists')
      }
      throw error
    }
    return { credentialId: stored.id }
  }

  async beginFounding() {
    // The user handle names no guild yet (none exists); a fresh id stands in for it.
    const options = await this.registrationOptions(crypto.randomUUID(), [])
    const now = this.config.clock.now()
    const challengeId = crypto.randomUUID()
    await this.store.saveDiscoverableChallenge(
      {
        id: challengeId,
        challenge: options.challenge,
        expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
      },
      now
    )
    return { challengeId, options }
  }

  async finishFounding(
    challengeId: string,
    response: RegistrationResponseJSON,
    found: (write: FoundingWrite) => Promise<string>
  ) {
    const challenge = z.uuid().safeParse(challengeId).success
      ? await this.store.takeDiscoverableChallenge(challengeId)
      : null
    if (!challenge || challenge.expiresAt <= this.config.clock.now()) {
      throw new IdentityError('invalid_challenge')
    }
    const stored = await this.verifiedCredential(null, challenge.challenge, response)
    try {
      const guildId = await found((tx, id) =>
        this.store.saveCredential(
          id,
          stored,
          { type: 'identity.passkey_registered', payload: { credentialId: stored.id } },
          tx
        )
      )
      return { guildId, credentialId: stored.id }
    } catch (error) {
      if (z.object({ code: z.literal('23505') }).safeParse(error).success) {
        throw new IdentityError('credential_exists')
      }
      throw error
    }
  }

  private registrationOptions(guildId: string, existing: StoredCredential[]) {
    return generateRegistrationOptions({
      rpID: this.config.rpId,
      timeout: WEBAUTHN_CEREMONY_TIMEOUT_MS,
      rpName: this.config.rpName,
      userName: 'guild-master',
      userDisplayName: 'Guild Master',
      userID: new TextEncoder().encode(guildId),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: c.transports })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
    })
  }

  /** Verifies an attestation and refuses a credential id another guild already holds (migration 0058). */
  private async verifiedCredential(
    guildId: string | null,
    expectedChallenge: string,
    response: RegistrationResponseJSON
  ): Promise<StoredCredential> {
    const verified = await verifyRegistrationResponse({
      response,
      expectedChallenge,
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
    const holder = await this.store.guildForCredential(stored.id)
    if (holder && (guildId === null || holder !== guildId)) {
      throw new IdentityError('credential_exists')
    }
    return stored
  }

  async beginSignIn(guildId: string) {
    const credentials = guildPrefix.safeParse(guildId).success
      ? await this.store.listCredentials(guildId)
      : []
    if (credentials.length === 0) {
      return this.decoySignIn(guildId)
    }
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
    return this.openSession(guildId)
  }

  private async openSession(guildId: string, notAfter?: Date): Promise<IdentitySession> {
    const token = `${guildId}.${randomToken()}`
    const full = this.config.clock.now().getTime() + SESSION_TTL_MS
    const expiresAt = new Date(notAfter ? Math.min(full, notAfter.getTime()) : full)
    const sessionId = crypto.randomUUID()
    const master = await this.store.guildMaster(guildId)
    await this.store.saveSession(
      guildId,
      {
        id: sessionId,
        memberId: master.memberId,
        tokenHash: await hashOf(token),
        expiresAt,
        reauthHash: null,
        reauthExpiresAt: null,
      },
      { type: 'identity.signed_in', payload: { sessionId } }
    )
    return { token, guildId, expiresAt }
  }

  async beginDiscoverableSignIn() {
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      timeout: WEBAUTHN_CEREMONY_TIMEOUT_MS,
      userVerification: 'required',
      allowCredentials: [],
    })
    const id = crypto.randomUUID()
    const now = this.config.clock.now()
    await this.store.saveDiscoverableChallenge(
      { id, challenge: options.challenge, expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS) },
      now
    )
    return { challengeId: id, options }
  }

  async finishDiscoverableSignIn(
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<IdentitySession> {
    const held = z.uuid().safeParse(challengeId).success
      ? await this.store.takeDiscoverableChallenge(challengeId)
      : null
    if (!held || held.expiresAt <= this.config.clock.now()) {
      throw new IdentityError('invalid_challenge')
    }
    // An unknown credential answers like a bad signature, so the response never says which.
    const guildId = await this.store.guildForCredential(response.id)
    if (!guildId) {
      throw new IdentityError('verification_failed')
    }
    await this.verifyAssertion(guildId, held, response)
    return this.openSession(guildId)
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
    await this.store.setReauth(live.guildId, live.session.id, await hashOf(proof), expiresAt, {
      type: 'identity.reauthenticated',
      payload: { sessionId: live.session.id },
    })
    return { proof, expiresAt }
  }

  async beginCheckpointSignature(sessionToken: string, checkpointHash: string) {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      throw new IdentityError('unauthenticated')
    }
    const challenge = new Uint8Array(48)
    challenge.set(Buffer.from(checkpointHash, 'hex'))
    challenge.set(crypto.getRandomValues(new Uint8Array(16)), 32)
    const options = await this.requestOptions(live.guildId, challenge)
    const challengeId = await this.saveChallenge(
      live.guildId,
      'checkpoint',
      options.challenge,
      live.session.id
    )
    return { challengeId, options }
  }

  async finishCheckpointSignature(
    sessionToken: string,
    challengeId: string,
    response: AuthenticationResponseJSON
  ): Promise<{ checkpointHash: string; assertion: CheckpointAssertion }> {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      throw new IdentityError('unauthenticated')
    }
    const challenge = await this.takeChallenge(live.guildId, challengeId, 'checkpoint')
    if (challenge.sessionId !== live.session.id) {
      throw new IdentityError('invalid_challenge')
    }
    await this.verifyAssertion(live.guildId, challenge, response)
    const hash = Buffer.from(isoBase64URL.toBuffer(challenge.challenge)).subarray(0, 32)
    return {
      checkpointHash: hash.toString('hex'),
      assertion: {
        credentialId: response.id,
        authenticatorData: response.response.authenticatorData,
        clientDataJSON: response.response.clientDataJSON,
        signature: response.response.signature,
      },
    }
  }

  async verifyCheckpointAssertion(
    guildId: string,
    checkpointHash: string,
    assertion: CheckpointAssertion
  ): Promise<boolean> {
    const credential = (await this.store.listCredentials(guildId)).find(
      (c) => c.id === assertion.credentialId
    )
    if (!credential) {
      return false
    }
    try {
      const clientData = z
        .object({ challenge: z.string() })
        .parse(
          JSON.parse(new TextDecoder().decode(isoBase64URL.toBuffer(assertion.clientDataJSON)))
        )
      const carried = Buffer.from(isoBase64URL.toBuffer(clientData.challenge)).subarray(0, 32)
      if (carried.toString('hex') !== checkpointHash) {
        return false
      }
      const verified = await verifyAuthenticationResponse({
        response: {
          id: assertion.credentialId,
          rawId: assertion.credentialId,
          type: 'public-key',
          clientExtensionResults: {},
          response: {
            clientDataJSON: assertion.clientDataJSON,
            authenticatorData: assertion.authenticatorData,
            signature: assertion.signature,
          },
        },
        expectedChallenge: clientData.challenge,
        expectedOrigin: this.config.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        // The counter moved on when the assertion was made; only the signature is re-checked here.
        credential: { id: credential.id, publicKey: credential.publicKey, counter: 0 },
      })
      return verified.verified
    } catch {
      return false
    }
  }

  async resolveSession(sessionToken: string): Promise<Principal | null> {
    const live = await this.liveSession(sessionToken)
    if (!live) {
      return null
    }
    // The role is read from the server's member record, never from the session or the request.
    const member = await this.store.findMember(live.guildId, live.session.memberId)
    return member ? { guildId: live.guildId, memberId: member.memberId, role: member.role } : null
  }

  async findMember(guildId: string, memberId: string) {
    return this.store.findMember(guildId, memberId)
  }

  async revokeSession(sessionToken: string): Promise<void> {
    const live = await this.liveSession(sessionToken)
    if (live) {
      await this.store.endSession(live.guildId, live.session.id, this.config.clock.now(), {
        type: 'identity.signed_out',
        payload: { sessionId: live.session.id },
      })
    }
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

  /**
   * Options for a guild that is unknown (or has no passkey yet), shaped like a real guild's. Every
   * variable part is derived from keyed MACs of the guild id, so it is stable per guild, varies
   * across guilds and is unguessable: 1 or 2 credentials, each id 16, 32 or 64 bytes, with
   * transports drawn from the sets real registrations produce (including none). The challenge id
   * is random and nothing is stored, so it can never be finished.
   * Callers cannot tell unknown guilds from known ones by status or shape. Residual: a known guild
   * costs database reads and writes that a decoy does not, so response time can still differ
   * slightly; the rate limits bound how many probes an attacker gets to measure it.
   */
  private async decoySignIn(guildId: string) {
    const mac = (purpose: string) =>
      this.config.keys.mac(guildId, purpose, new TextEncoder().encode('sign-in'))
    const shape = Buffer.from(await mac('decoy-shape'), 'hex')
    const count = 1 + ((shape[0] ?? 0) % 2)
    const allowCredentials = []
    for (let i = 0; i < count; i++) {
      const length = DECOY_ID_BYTES[(shape[1 + i] ?? 0) % DECOY_ID_BYTES.length] ?? 32
      const transports = DECOY_TRANSPORTS[(shape[3 + i] ?? 0) % DECOY_TRANSPORTS.length] ?? []
      const bytes = Buffer.concat([
        Buffer.from(await mac(`decoy-credential:${i}:0`), 'hex'),
        Buffer.from(await mac(`decoy-credential:${i}:1`), 'hex'),
      ]).subarray(0, length)
      allowCredentials.push({ id: isoBase64URL.fromBuffer(new Uint8Array(bytes)), transports })
    }
    const options = await generateAuthenticationOptions({
      rpID: this.config.rpId,
      timeout: WEBAUTHN_CEREMONY_TIMEOUT_MS,
      userVerification: 'required',
      allowCredentials,
    })
    return { challengeId: crypto.randomUUID(), options }
  }

  private async requestOptions(guildId: string, challenge?: Uint8Array<ArrayBuffer>) {
    const credentials = await this.store.listCredentials(guildId)
    return generateAuthenticationOptions({
      ...(challenge ? { challenge } : {}),
      rpID: this.config.rpId,
      timeout: WEBAUTHN_CEREMONY_TIMEOUT_MS,
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
    challenge: { challenge: string },
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
