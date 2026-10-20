import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import type { Db } from '../db/client'
import type {
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredSession,
} from './identity-store'

const credentialRow = z.object({
  credential_id: z.string(),
  public_key: z.string(),
  counter: z.coerce.number(),
  transports: z.array(z.string()),
})
const challengeRow = z.object({
  challenge_id: z.string(),
  kind: z.enum(['register', 'signin', 'reauth']),
  challenge: z.string(),
  session_id: z.string().nullable(),
  expires_at: z.date(),
})
const sessionRow = z.object({
  session_id: z.string(),
  token_hash: z.string(),
  expires_at: z.date(),
  reauth_hash: z.string().nullable(),
  reauth_expires_at: z.date().nullable(),
})

/** Postgres {@link IdentityStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild. */
export class PgIdentityStore implements IdentityStore {
  constructor(private readonly db: Db) {}

  async listCredentials(guildId: string): Promise<StoredCredential[]> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select credential_id, public_key, counter, transports from identity_credentials
           where guild_id = ${guildId} order by created_at, credential_id`
    )
    return rows.map((raw) => {
      const row = credentialRow.parse(raw)
      return {
        id: row.credential_id,
        publicKey: new Uint8Array(isoBase64URL.toBuffer(row.public_key)),
        counter: row.counter,
        transports: row.transports,
      }
    })
  }

  async saveCredential(guildId: string, c: StoredCredential): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`insert into identity_credentials (guild_id, credential_id, public_key, counter, transports)
           values (${guildId}, ${c.id}, ${isoBase64URL.fromBuffer(c.publicKey)}, ${c.counter}, ${c.transports})
           on conflict (guild_id, credential_id) do nothing`
    )
  }

  async updateCounter(guildId: string, credentialId: string, counter: number): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`update identity_credentials set counter = ${counter}
           where guild_id = ${guildId} and credential_id = ${credentialId}`
    )
  }

  async saveChallenge(guildId: string, c: StoredChallenge): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`insert into identity_challenges (guild_id, challenge_id, kind, challenge, session_id, expires_at)
           values (${guildId}, ${c.id}, ${c.kind}, ${c.challenge}, ${c.sessionId}, ${c.expiresAt})`
    )
  }

  async takeChallenge(guildId: string, id: string): Promise<StoredChallenge | null> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`delete from identity_challenges where guild_id = ${guildId} and challenge_id = ${id}
           returning challenge_id, kind, challenge, session_id, expires_at`
    )
    if (!rows[0]) {
      return null
    }
    const row = challengeRow.parse(rows[0])
    return {
      id: row.challenge_id,
      kind: row.kind,
      challenge: row.challenge,
      sessionId: row.session_id,
      expiresAt: row.expires_at,
    }
  }

  async saveSession(guildId: string, s: StoredSession): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`insert into identity_sessions (guild_id, session_id, token_hash, expires_at)
           values (${guildId}, ${s.id}, ${s.tokenHash}, ${s.expiresAt})`
    )
  }

  async findSession(guildId: string, tokenHash: string): Promise<StoredSession | null> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select session_id, token_hash, expires_at, reauth_hash, reauth_expires_at
           from identity_sessions where guild_id = ${guildId} and token_hash = ${tokenHash}`
    )
    if (!rows[0]) {
      return null
    }
    const row = sessionRow.parse(rows[0])
    return {
      id: row.session_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      reauthHash: row.reauth_hash,
      reauthExpiresAt: row.reauth_expires_at,
    }
  }

  async setReauth(
    guildId: string,
    sessionId: string,
    hash: string,
    expiresAt: Date
  ): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`update identity_sessions set reauth_hash = ${hash}, reauth_expires_at = ${expiresAt}
           where guild_id = ${guildId} and session_id = ${sessionId}`
    )
  }
}
