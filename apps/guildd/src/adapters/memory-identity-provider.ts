import type {
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredSession,
} from './identity-store'
import { type WebAuthnIdentityConfig, WebAuthnIdentityProvider } from './webauthn-identity-provider'

/** In-memory {@link IdentityStore}, keyed by guild so scoping matches the Postgres adapter. */
export class MemoryIdentityStore implements IdentityStore {
  private readonly credentials = new Map<string, StoredCredential[]>()
  private readonly challenges = new Map<string, StoredChallenge>()
  private readonly sessions = new Map<string, StoredSession>()

  async listCredentials(guildId: string) {
    return [...(this.credentials.get(guildId) ?? [])]
  }

  async saveCredential(guildId: string, credential: StoredCredential) {
    const list = this.credentials.get(guildId) ?? []
    if (!list.some((c) => c.id === credential.id)) {
      this.credentials.set(guildId, [...list, credential])
    }
  }

  async updateCounter(guildId: string, credentialId: string, counter: number) {
    this.credentials.set(
      guildId,
      (this.credentials.get(guildId) ?? []).map((c) =>
        c.id === credentialId ? { ...c, counter } : c
      )
    )
  }

  async saveChallenge(guildId: string, challenge: StoredChallenge) {
    this.challenges.set(`${guildId}/${challenge.id}`, challenge)
  }

  async takeChallenge(guildId: string, id: string) {
    const key = `${guildId}/${id}`
    const challenge = this.challenges.get(key) ?? null
    this.challenges.delete(key)
    return challenge
  }

  async saveSession(guildId: string, session: StoredSession) {
    this.sessions.set(`${guildId}/${session.tokenHash}`, session)
  }

  async findSession(guildId: string, tokenHash: string) {
    return this.sessions.get(`${guildId}/${tokenHash}`) ?? null
  }

  async setReauth(guildId: string, sessionId: string, hash: string, expiresAt: Date) {
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${guildId}/`) && session.id === sessionId) {
        this.sessions.set(key, { ...session, reauthHash: hash, reauthExpiresAt: expiresAt })
      }
    }
  }
}

/** Memory adapter for {@link IdentityProvider}: the real WebAuthn core over in-memory storage. */
export class MemoryIdentityProvider extends WebAuthnIdentityProvider {
  constructor(config: WebAuthnIdentityConfig) {
    super(new MemoryIdentityStore(), config)
  }
}
