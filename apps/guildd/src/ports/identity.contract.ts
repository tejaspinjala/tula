import { describe, expect, test } from 'bun:test'
import type { MemoryClock } from '../adapters/memory-clock'
import { SoftwareAuthenticator } from '../testing/software-authenticator'
import {
  CHALLENGE_TTL_MS,
  IdentityError,
  type IdentityProvider,
  REAUTH_TTL_MS,
  SESSION_TTL_MS,
} from './identity'

/** What a contract run needs: a fresh provider, its clock and a way to mint guild ids. */
export interface IdentityContractSubject {
  identity: IdentityProvider
  clock: MemoryClock
  /** Returns the id of a new guild (the embedded adapter needs a real one). */
  newGuild: () => Promise<string>
  rpId: string
  origin: string
}

/** The failure code a call rejects with, or `no_error` when it resolves. */
async function failure(call: Promise<unknown>): Promise<string> {
  try {
    await call
    return 'no_error'
  } catch (error) {
    if (error instanceof IdentityError) {
      return error.code
    }
    throw error
  }
}

/**
 * The IdentityProvider contract, run against every adapter. `make` returns a fresh subject;
 * authenticators are software passkeys that answer ceremonies like a browser.
 */
export function identityContract(name: string, make: () => Promise<IdentityContractSubject>) {
  describe(`IdentityProvider contract: ${name}`, () => {
    async function registered() {
      const subject = await make()
      const guildId = await subject.newGuild()
      const key = await SoftwareAuthenticator.create(subject.rpId, subject.origin)
      const begin = await subject.identity.beginRegistration(guildId)
      await subject.identity.finishRegistration(
        guildId,
        begin.challengeId,
        await key.register(begin.options)
      )
      return { ...subject, guildId, key }
    }

    async function signIn(s: Awaited<ReturnType<typeof registered>>) {
      const begin = await s.identity.beginSignIn(s.guildId)
      return s.identity.finishSignIn(
        s.guildId,
        begin.challengeId,
        await s.key.assert(begin.options)
      )
    }

    test('registering then signing in yields a session bound to that guild', async () => {
      const s = await registered()
      expect(await s.identity.hasCredentials(s.guildId)).toBe(true)
      const session = await signIn(s)
      expect(session.guildId).toBe(s.guildId)
      expect(await s.identity.resolveSession(session.token)).toEqual({ guildId: s.guildId })
      expect(await s.identity.resolveSession('not-a-token')).toBeNull()
    })

    test('a challenge is single use', async () => {
      const s = await registered()
      const begin = await s.identity.beginSignIn(s.guildId)
      const response = await s.key.assert(begin.options)
      await s.identity.finishSignIn(s.guildId, begin.challengeId, response)
      expect(await failure(s.identity.finishSignIn(s.guildId, begin.challengeId, response))).toBe(
        'invalid_challenge'
      )
    })

    test('an assertion from another origin or another key is refused', async () => {
      const s = await registered()
      const phished = await s.identity.beginSignIn(s.guildId)
      expect(
        await failure(
          s.identity.finishSignIn(
            s.guildId,
            phished.challengeId,
            await s.key.assert(phished.options, 'https://evil.example')
          )
        )
      ).toBe('verification_failed')
      const stranger = await SoftwareAuthenticator.create(s.rpId, s.origin)
      const begin = await s.identity.beginSignIn(s.guildId)
      expect(
        await failure(
          s.identity.finishSignIn(
            s.guildId,
            begin.challengeId,
            await stranger.assert(begin.options)
          )
        )
      ).toBe('unknown_credential')
    })

    test('a session expires', async () => {
      const s = await registered()
      const session = await signIn(s)
      s.clock.advance(SESSION_TTL_MS + 1)
      expect(await s.identity.resolveSession(session.token)).toBeNull()
    })

    test('a challenge expires', async () => {
      const s = await registered()
      const begin = await s.identity.beginSignIn(s.guildId)
      s.clock.advance(CHALLENGE_TTL_MS + 1)
      expect(
        await failure(
          s.identity.finishSignIn(s.guildId, begin.challengeId, await s.key.assert(begin.options))
        )
      ).toBe('invalid_challenge')
    })

    test('a re-authentication proof is required, tied to its session, and expires', async () => {
      const s = await registered()
      const session = await signIn(s)
      const other = await signIn(s)
      expect(await s.identity.checkReauth(session.token, 'guess')).toBe(false)

      const begin = await s.identity.beginReauth(session.token)
      const { proof, expiresAt } = await s.identity.finishReauth(
        session.token,
        begin.challengeId,
        await s.key.assert(begin.options)
      )
      expect(expiresAt.getTime()).toBe(s.clock.now().getTime() + REAUTH_TTL_MS)
      expect(await s.identity.checkReauth(session.token, proof)).toBe(true)
      expect(await s.identity.checkReauth(other.token, proof)).toBe(false)
      expect(await s.identity.checkReauth(session.token, `${proof}x`)).toBe(false)

      s.clock.advance(REAUTH_TTL_MS + 1)
      expect(await s.identity.checkReauth(session.token, proof)).toBe(false)
    })

    test('re-authentication needs a live session', async () => {
      const s = await registered()
      expect(await failure(s.identity.beginReauth('nope'))).toBe('unauthenticated')
    })

    test('a passkey and a session belong to one guild only', async () => {
      const a = await registered()
      const guildB = await a.newGuild()
      const sessionA = await signIn(a)
      expect(await a.identity.hasCredentials(guildB)).toBe(false)

      const atB = await a.identity.beginSignIn(guildB)
      expect(
        await failure(
          a.identity.finishSignIn(guildB, atB.challengeId, await a.key.assert(atB.options))
        )
      ).toBe('unknown_credential')

      const fromA = await a.identity.beginSignIn(a.guildId)
      expect(
        await failure(
          a.identity.finishSignIn(guildB, fromA.challengeId, await a.key.assert(fromA.options))
        )
      ).toBe('invalid_challenge')

      // Once B has its own passkey, A's session cannot add another to B.
      const keyB = await SoftwareAuthenticator.create(a.rpId, a.origin)
      const reg = await a.identity.beginRegistration(guildB)
      await a.identity.finishRegistration(guildB, reg.challengeId, await keyB.register(reg.options))
      expect(await failure(a.identity.beginRegistration(guildB, sessionA.token))).toBe(
        'registration_closed'
      )
    })

    test('a further passkey needs a session of the same guild', async () => {
      const s = await registered()
      expect(await failure(s.identity.beginRegistration(s.guildId))).toBe('registration_closed')
      expect(await failure(s.identity.beginRegistration(s.guildId, 'nope'))).toBe(
        'registration_closed'
      )
      const session = await signIn(s)
      expect(await failure(s.identity.beginRegistration(s.guildId, session.token))).toBe('no_error')
    })
  })
}
