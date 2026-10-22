import { foundingKeyOf } from './found-via-api'
import { SoftwareAuthenticator } from './software-authenticator'

/** The slice of the identity provider needed to open a session. */
interface Identity {
  issueFoundingToken(guildId: string): Promise<{ token: string }>
  beginRegistration(
    guildId: string,
    auth: { foundingToken: string }
  ): Promise<{ challengeId: string; options: Parameters<SoftwareAuthenticator['register']>[0] }>
  finishRegistration(
    guildId: string,
    challengeId: string,
    response: Awaited<ReturnType<SoftwareAuthenticator['register']>>
  ): Promise<unknown>
  beginSignIn(
    guildId: string
  ): Promise<{ challengeId: string; options: Parameters<SoftwareAuthenticator['assert']>[0] }>
  finishSignIn(
    guildId: string,
    challengeId: string,
    response: Awaited<ReturnType<SoftwareAuthenticator['assert']>>
  ): Promise<{ token: string }>
}

/**
 * Test-only: signs in to an already-founded guild (registering a software passkey first if it has none), straight
 * through the identity provider. Returns the guild's bearer session token.
 */
export async function openSession(identity: Identity, guildId: string): Promise<string> {
  // A guild founded through the atomic ceremony already holds its first passkey: sign in with it.
  // A guild written straight into the database has none: register one with a founding token.
  let key = foundingKeyOf(guildId)
  if (!key) {
    key = await SoftwareAuthenticator.create('localhost', 'http://localhost:5173')
    const founding = await identity.issueFoundingToken(guildId)
    const reg = await identity.beginRegistration(guildId, { foundingToken: founding.token })
    await identity.finishRegistration(guildId, reg.challengeId, await key.register(reg.options))
  }
  const sign = await identity.beginSignIn(guildId)
  const session = await identity.finishSignIn(
    guildId,
    sign.challengeId,
    await key.assert(sign.options)
  )
  return session.token
}
