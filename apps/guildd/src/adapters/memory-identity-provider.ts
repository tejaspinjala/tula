import type { TenantTx } from '../db/client'
import { MAX_OUTSTANDING_CHALLENGES } from '../ports/identity'
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
  private readonly founding = new Map<string, { tokenHash: string; expiresAt: Date }>()

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

  async saveChallenge(guildId: string, challenge: StoredChallenge, now: Date) {
    const prefix = `${guildId}/`
    for (const [key, held] of this.challenges) {
      if (key.startsWith(prefix) && held.expiresAt <= now) {
        this.challenges.delete(key)
      }
    }
    this.challenges.set(`${prefix}${challenge.id}`, challenge)
    const mine = [...this.challenges].filter(([key]) => key.startsWith(prefix))
    // Map iteration is insertion order, so a stable sort by expiry keeps ties oldest-first.
    mine.sort((a, b) => a[1].expiresAt.getTime() - b[1].expiresAt.getTime())
    for (const [key] of mine.slice(0, Math.max(0, mine.length - MAX_OUTSTANDING_CHALLENGES))) {
      this.challenges.delete(key)
    }
  }

  async issueFounding(guildId: string, tokenHash: string, expiresAt: Date, _tx?: TenantTx) {
    this.founding.set(guildId, { tokenHash, expiresAt })
  }

  async hasFounding(guildId: string, tokenHash: string, now: Date) {
    const held = this.founding.get(guildId)
    return held !== undefined && held.tokenHash === tokenHash && held.expiresAt > now
  }

  // No await between the checks and the writes, so this is atomic within the process.
  async foundCredential(
    guildId: string,
    credential: StoredCredential,
    tokenHash: string,
    now: Date
  ) {
    const held = this.founding.get(guildId)
    if (
      (this.credentials.get(guildId) ?? []).length > 0 ||
      held === undefined ||
      held.tokenHash !== tokenHash ||
      held.expiresAt <= now
    ) {
      return false
    }
    this.founding.delete(guildId)
    this.credentials.set(guildId, [credential])
    return true
  }

  async clearReauth(guildId: string, sessionId: string, hash: string) {
    for (const [key, session] of this.sessions) {
      if (
        key.startsWith(`${guildId}/`) &&
        session.id === sessionId &&
        session.reauthHash === hash
      ) {
        this.sessions.set(key, { ...session, reauthHash: null, reauthExpiresAt: null })
        return true
      }
    }
    return false
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
