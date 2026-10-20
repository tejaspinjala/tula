import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import type { MemoryClock } from '../adapters/memory-clock'
import { SoftwareAuthenticator } from '../testing/software-authenticator'
import {
  CHALLENGE_TTL_MS,
  FOUNDING_TTL_MS,
  IdentityError,
  type IdentityProvider,
  MAX_OUTSTANDING_CHALLENGES,
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
  /** The guild's audit events, in order, as the chained event log holds them. */
  events: (guildId: string) => Promise<{ type: string; payload: unknown }[]>
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
      const { token } = await subject.identity.issueFoundingToken(guildId)
      const begin = await subject.identity.beginRegistration(guildId, { foundingToken: token })
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

    test('founding, sign-in and re-auth each append a non-secret event of ids only', async () => {
      const subject = await make()
      const guildId = await subject.newGuild()
      const key = await SoftwareAuthenticator.create(subject.rpId, subject.origin)
      const founding = await subject.identity.issueFoundingToken(guildId)
      const begin = await subject.identity.beginRegistration(guildId, {
        foundingToken: founding.token,
      })
      const registration = await key.register(begin.options)
      const { credentialId } = await subject.identity.finishRegistration(
        guildId,
        begin.challengeId,
        registration
      )
      const signBegin = await subject.identity.beginSignIn(guildId)
      const assertion = await key.assert(signBegin.options)
      const session = await subject.identity.finishSignIn(guildId, signBegin.challengeId, assertion)
      const reBegin = await subject.identity.beginReauth(session.token)
      const reAssertion = await key.assert(reBegin.options)
      const reauth = await subject.identity.finishReauth(
        session.token,
        reBegin.challengeId,
        reAssertion
      )

      const events = (await subject.events(guildId)).filter((e) => e.type.startsWith('identity.'))
      expect(events.map((e) => e.type)).toEqual([
        'identity.founding_token_issued',
        'identity.founding_token_spent',
        'identity.passkey_registered',
        'identity.signed_in',
        'identity.reauthenticated',
      ])
      expect(
        JSON.stringify(events.find((e) => e.type === 'identity.passkey_registered'))
      ).toContain(credentialId)
      const serialised = JSON.stringify(events)
      const secrets = [
        founding.token,
        session.token,
        reauth.proof,
        begin.options.challenge,
        signBegin.options.challenge,
        reBegin.options.challenge,
        registration.response.attestationObject,
        registration.response.clientDataJSON,
        assertion.response.signature,
        reAssertion.response.signature,
        ...[founding.token, session.token, reauth.proof].map((v) =>
          createHash('sha256').update(v).digest('base64url')
        ),
      ]
      const publicKey = registration.response.publicKey
      if (publicKey) {
        secrets.push(publicKey)
      }
      for (const event of events) {
        const keys = Object.keys(event.payload ?? {})
        const allowed = [[], ['credentialId'], ['sessionId']].map((k) => JSON.stringify(k))
        expect(allowed).toContain(JSON.stringify(keys))
      }
      for (const secret of secrets) {
        expect(serialised).not.toContain(secret)
      }
    })

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
      const founding = await a.identity.issueFoundingToken(guildB)
      const reg = await a.identity.beginRegistration(guildB, { foundingToken: founding.token })
      await a.identity.finishRegistration(guildB, reg.challengeId, await keyB.register(reg.options))
      expect(
        await failure(a.identity.beginRegistration(guildB, { sessionToken: sessionA.token }))
      ).toBe('registration_closed')
    })

    test('a further passkey needs a session of the same guild', async () => {
      const s = await registered()
      expect(await failure(s.identity.beginRegistration(s.guildId, {}))).toBe('registration_closed')
      expect(await failure(s.identity.beginRegistration(s.guildId, { sessionToken: 'nope' }))).toBe(
        'registration_closed'
      )
      const session = await signIn(s)
      expect(
        await failure(s.identity.beginRegistration(s.guildId, { sessionToken: session.token }))
      ).toBe('no_error')
    })

    test('a guild with no passkey needs its founding token, which is single use and expires', async () => {
      const s = await make()
      const guildId = await s.newGuild()
      expect(await failure(s.identity.beginRegistration(guildId))).toBe('registration_closed')
      expect(await failure(s.identity.beginRegistration(guildId, { foundingToken: 'guess' }))).toBe(
        'registration_closed'
      )

      const expired = await s.identity.issueFoundingToken(guildId)
      s.clock.advance(FOUNDING_TTL_MS + 1)
      expect(
        await failure(s.identity.beginRegistration(guildId, { foundingToken: expired.token }))
      ).toBe('registration_closed')

      const fresh = await s.identity.issueFoundingToken(guildId)
      const key = await SoftwareAuthenticator.create(s.rpId, s.origin)
      const begin = await s.identity.beginRegistration(guildId, { foundingToken: fresh.token })
      await s.identity.finishRegistration(
        guildId,
        begin.challengeId,
        await key.register(begin.options)
      )
      expect(
        await failure(s.identity.beginRegistration(guildId, { foundingToken: fresh.token }))
      ).toBe('registration_closed')
    })

    test('a stale founding challenge cannot add a passkey after the guild registered one', async () => {
      const s = await make()
      const guildId = await s.newGuild()
      const { token } = await s.identity.issueFoundingToken(guildId)
      const keyA = await SoftwareAuthenticator.create(s.rpId, s.origin)
      const keyB = await SoftwareAuthenticator.create(s.rpId, s.origin)
      const beginA = await s.identity.beginRegistration(guildId, { foundingToken: token })
      const beginB = await s.identity.beginRegistration(guildId, { foundingToken: token })
      await s.identity.finishRegistration(
        guildId,
        beginA.challengeId,
        await keyA.register(beginA.options)
      )
      expect(
        await failure(
          s.identity.finishRegistration(
            guildId,
            beginB.challengeId,
            await keyB.register(beginB.options)
          )
        )
      ).toBe('registration_closed')
      const signIn = await s.identity.beginSignIn(guildId)
      expect(
        await failure(
          s.identity.finishSignIn(guildId, signIn.challengeId, await keyB.assert(signIn.options))
        )
      ).toBe('unknown_credential')
    })

    test('two simultaneous founding finishes register exactly one passkey', async () => {
      const s = await make()
      const guildId = await s.newGuild()
      const { token } = await s.identity.issueFoundingToken(guildId)
      const keys = [
        await SoftwareAuthenticator.create(s.rpId, s.origin),
        await SoftwareAuthenticator.create(s.rpId, s.origin),
      ]
      const attempts = await Promise.all(
        keys.map(async (key) => {
          const begin = await s.identity.beginRegistration(guildId, { foundingToken: token })
          return { key, begin, response: await key.register(begin.options) }
        })
      )
      const outcomes = await Promise.all(
        attempts.map((a) =>
          failure(s.identity.finishRegistration(guildId, a.begin.challengeId, a.response))
        )
      )
      expect(outcomes.filter((o) => o === 'no_error')).toHaveLength(1)
      let signedIn = 0
      for (const { key } of attempts) {
        const begin = await s.identity.beginSignIn(guildId)
        if (
          (await failure(
            s.identity.finishSignIn(guildId, begin.challengeId, await key.assert(begin.options))
          )) === 'no_error'
        ) {
          signedIn++
        }
      }
      expect(signedIn).toBe(1)
    })

    test('a session registration challenge cannot be finished without the same session', async () => {
      const s = await registered()
      const session = await signIn(s)
      const other = await signIn(s)
      const key2 = await SoftwareAuthenticator.create(s.rpId, s.origin)
      const begin = await s.identity.beginRegistration(s.guildId, { sessionToken: session.token })
      const response = await key2.register(begin.options)
      expect(
        await failure(s.identity.finishRegistration(s.guildId, begin.challengeId, response))
      ).toBe('registration_closed')
      const again = await s.identity.beginRegistration(s.guildId, { sessionToken: session.token })
      expect(
        await failure(
          s.identity.finishRegistration(
            s.guildId,
            again.challengeId,
            await key2.register(again.options),
            {
              sessionToken: other.token,
            }
          )
        )
      ).toBe('registration_closed')
      const third = await s.identity.beginRegistration(s.guildId, { sessionToken: session.token })
      await s.identity.finishRegistration(
        s.guildId,
        third.challengeId,
        await key2.register(third.options),
        {
          sessionToken: session.token,
        }
      )
    })

    test('a consumed re-authentication proof works exactly once', async () => {
      const s = await registered()
      const session = await signIn(s)
      const begin = await s.identity.beginReauth(session.token)
      const { proof } = await s.identity.finishReauth(
        session.token,
        begin.challengeId,
        await s.key.assert(begin.options)
      )
      expect(await s.identity.consumeReauth(session.token, 'wrong')).toBe(false)
      expect(await s.identity.consumeReauth(session.token, proof)).toBe(true)
      expect(await s.identity.consumeReauth(session.token, proof)).toBe(false)
      expect(await s.identity.checkReauth(session.token, proof)).toBe(false)
    })

    test('outstanding challenges are capped per guild, evicting the oldest', async () => {
      const s = await registered()
      const first = await s.identity.beginSignIn(s.guildId)
      const firstResponse = await s.key.assert(first.options)
      for (let i = 0; i < MAX_OUTSTANDING_CHALLENGES; i++) {
        s.clock.advance(1)
        await s.identity.beginSignIn(s.guildId)
      }
      expect(
        await failure(s.identity.finishSignIn(s.guildId, first.challengeId, firstResponse))
      ).toBe('invalid_challenge')
      const last = await s.identity.beginSignIn(s.guildId)
      await s.identity.finishSignIn(s.guildId, last.challengeId, await s.key.assert(last.options))
    })
  })
}
