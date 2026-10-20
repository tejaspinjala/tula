import type { TenantTx } from '../db/client'
import { MAX_OUTSTANDING_CHALLENGES } from '../ports/identity'
import type {
  IdentityEvent,
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredMember,
  StoredSession,
} from './identity-store'
import { type WebAuthnIdentityConfig, WebAuthnIdentityProvider } from './webauthn-identity-provider'

/** In-memory {@link IdentityStore}, keyed by guild so scoping matches the Postgres adapter. */
export class MemoryIdentityStore implements IdentityStore {
  private readonly credentials = new Map<string, StoredCredential[]>()
  private readonly challenges = new Map<string, StoredChallenge>()
  private readonly sessions = new Map<string, StoredSession>()
  private readonly founding = new Map<string, { tokenHash: string; expiresAt: Date }>()
  private readonly events = new Map<string, IdentityEvent[]>()
  private readonly masters = new Map<string, StoredMember>()

  /** The audit events appended for the guild so far, in order. */
  eventsOf(guildId: string): IdentityEvent[] {
    return [...(this.events.get(guildId) ?? [])]
  }

  private record(guildId: string, ...events: IdentityEvent[]) {
    this.events.set(guildId, [...(this.events.get(guildId) ?? []), ...events])
  }

  async listCredentials(guildId: string) {
    return [...(this.credentials.get(guildId) ?? [])]
  }

  async saveCredential(guildId: string, credential: StoredCredential, event: IdentityEvent) {
    const list = this.credentials.get(guildId) ?? []
    if (!list.some((c) => c.id === credential.id)) {
      this.credentials.set(guildId, [...list, credential])
      this.record(guildId, event)
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
    // The cap is per kind, so unauthenticated sign-in begins cannot evict a pending reauth.
    const mine = [...this.challenges].filter(
      ([key, held]) => key.startsWith(prefix) && held.kind === challenge.kind
    )
    // Map iteration is insertion order, so a stable sort by expiry keeps ties oldest-first.
    mine.sort((a, b) => a[1].expiresAt.getTime() - b[1].expiresAt.getTime())
    for (const [key] of mine.slice(0, Math.max(0, mine.length - MAX_OUTSTANDING_CHALLENGES))) {
      this.challenges.delete(key)
    }
  }

  async issueFounding(
    guildId: string,
    tokenHash: string,
    expiresAt: Date,
    event: IdentityEvent,
    _tx?: TenantTx
  ) {
    this.found(guildId)
    this.founding.set(guildId, { tokenHash, expiresAt })
    this.record(guildId, event)
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
    now: Date,
    events: IdentityEvent[]
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
    this.record(guildId, ...events)
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

  /** Founds the guild in memory: mints its Guild Master once; founding again changes nothing. */
  found(guildId: string): void {
    if (!this.masters.has(guildId)) {
      this.masters.set(guildId, { memberId: crypto.randomUUID(), role: 'guild_master' })
    }
  }

  async guildMaster(guildId: string): Promise<StoredMember> {
    const master = this.masters.get(guildId)
    if (!master) {
      throw new Error('guild has no Guild Master')
    }
    return master
  }

  async findMember(guildId: string, memberId: string): Promise<StoredMember | null> {
    const master = this.masters.get(guildId)
    return master?.memberId === memberId ? master : null
  }

  async saveSession(guildId: string, session: StoredSession, event: IdentityEvent) {
    this.sessions.set(`${guildId}/${session.tokenHash}`, session)
    this.record(guildId, event)
  }

  async findSession(guildId: string, tokenHash: string) {
    return this.sessions.get(`${guildId}/${tokenHash}`) ?? null
  }

  async setReauth(
    guildId: string,
    sessionId: string,
    hash: string,
    expiresAt: Date,
    event: IdentityEvent
  ) {
    for (const [key, session] of this.sessions) {
      if (key.startsWith(`${guildId}/`) && session.id === sessionId) {
        this.sessions.set(key, { ...session, reauthHash: hash, reauthExpiresAt: expiresAt })
        this.record(guildId, event)
        return
      }
    }
    throw new Error('unknown session')
  }
}

/** Memory adapter for {@link IdentityProvider}: the real WebAuthn core over in-memory storage. */
export class MemoryIdentityProvider extends WebAuthnIdentityProvider {
  constructor(config: WebAuthnIdentityConfig) {
    super(new MemoryIdentityStore(), config)
  }
}
