import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import { MAX_OUTSTANDING_CHALLENGES } from '../ports/identity'
import type { KeyProvider } from '../ports/key-provider'
import type {
  IdentityEvent,
  IdentityStore,
  StoredChallenge,
  StoredCredential,
  StoredDesktopCode,
  StoredDiscoverableChallenge,
  StoredMember,
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
  kind: z.enum(['register', 'signin', 'reauth', 'checkpoint', 'enrol']),
  challenge: z.string(),
  session_id: z.string().nullable(),
  founding_hash: z.string().nullable(),
  expires_at: z.date(),
})
const memberRow = z.object({ member_id: z.string(), role: z.literal('guild_master') })
const sessionRow = z.object({
  session_id: z.string(),
  member_id: z.string(),
  token_hash: z.string(),
  expires_at: z.date(),
  reauth_hash: z.string().nullable(),
  reauth_expires_at: z.date().nullable(),
})

function toMember(row: z.infer<typeof memberRow>): StoredMember {
  return { memberId: row.member_id, role: row.role }
}

/** Postgres {@link IdentityStore}: every call runs in `Db.withGuild`, so RLS scopes it to one guild. */
export class PgIdentityStore implements IdentityStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider
  ) {}

  private append(tx: TenantTx, event: IdentityEvent) {
    return appendEvent(tx, this.keys, event.type, event.payload)
  }

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

  async saveCredential(guildId: string, c: StoredCredential, event: IdentityEvent): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      const inserted =
        await tx`insert into identity_credentials (guild_id, credential_id, public_key, counter, transports)
           values (${guildId}, ${c.id}, ${isoBase64URL.fromBuffer(c.publicKey)}, ${c.counter}, ${c.transports})
           on conflict (guild_id, credential_id) do nothing returning 1`
      if (inserted.length > 0) {
        await this.append(tx, event)
      }
    })
  }

  async updateCounter(guildId: string, credentialId: string, counter: number): Promise<void> {
    await this.db.withGuild(
      guildId,
      (tx) =>
        tx`update identity_credentials set counter = ${counter}
           where guild_id = ${guildId} and credential_id = ${credentialId}`
    )
  }

  async saveChallenge(guildId: string, c: StoredChallenge, now: Date): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`delete from identity_challenges where guild_id = ${guildId} and expires_at <= ${now}`
      await tx`insert into identity_challenges
          (guild_id, challenge_id, kind, challenge, session_id, founding_hash, expires_at)
        values (${guildId}, ${c.id}, ${c.kind}, ${c.challenge}, ${c.sessionId}, ${c.foundingHash}, ${c.expiresAt})`
      // The cap is per kind, so unauthenticated sign-in begins cannot evict a pending reauth.
      await tx`delete from identity_challenges where guild_id = ${guildId} and challenge_id in (
          select challenge_id from identity_challenges
          where guild_id = ${guildId} and kind = ${c.kind}
          order by expires_at desc, challenge_id offset ${MAX_OUTSTANDING_CHALLENGES})`
    })
  }

  async issueFounding(
    guildId: string,
    tokenHash: string,
    expiresAt: Date,
    event: IdentityEvent,
    tx?: TenantTx
  ): Promise<void> {
    const write = async (t: TenantTx) => {
      await t`insert into identity_founding (guild_id, token_hash, expires_at)
        values (${guildId}, ${tokenHash}, ${expiresAt})
        on conflict (guild_id) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at`
      await this.append(t, event)
    }
    await (tx ? write(tx) : this.db.withGuild(guildId, write))
  }

  async hasFounding(guildId: string, tokenHash: string, now: Date): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select 1 from identity_founding
           where guild_id = ${guildId} and token_hash = ${tokenHash} and expires_at > ${now}`
    )
    return rows.length > 0
  }

  async foundCredential(
    guildId: string,
    c: StoredCredential,
    tokenHash: string,
    now: Date,
    events: IdentityEvent[]
  ): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      // The guild row lock serialises concurrent founding finishes: the loser sees the winner's passkey.
      await tx`select 1 from guilds where guild_id = ${guildId} for update`
      const held = await tx`select 1 from identity_credentials where guild_id = ${guildId} limit 1`
      if (held.length > 0) {
        return false
      }
      const spent = await tx`delete from identity_founding
        where guild_id = ${guildId} and token_hash = ${tokenHash} and expires_at > ${now} returning 1`
      if (spent.length === 0) {
        return false
      }
      await tx`insert into identity_credentials (guild_id, credential_id, public_key, counter, transports)
        values (${guildId}, ${c.id}, ${isoBase64URL.fromBuffer(c.publicKey)}, ${c.counter}, ${c.transports})`
      for (const event of events) {
        await this.append(tx, event)
      }
      return true
    })
  }

  async issueEnrolment(
    guildId: string,
    tokenHash: string,
    expiresAt: Date,
    event: IdentityEvent
  ): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`insert into identity_enrolments (guild_id, token_hash, expires_at)
        values (${guildId}, ${tokenHash}, ${expiresAt})
        on conflict (guild_id) do update set token_hash = excluded.token_hash, expires_at = excluded.expires_at`
      await this.append(tx, event)
    })
  }

  async hasEnrolment(guildId: string, tokenHash: string, now: Date): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select 1 from identity_enrolments
           where guild_id = ${guildId} and token_hash = ${tokenHash} and expires_at > ${now}`
    )
    return rows.length > 0
  }

  async enrolCredential(
    guildId: string,
    c: StoredCredential,
    tokenHash: string,
    now: Date,
    events: IdentityEvent[]
  ): Promise<boolean> {
    return this.db.withGuild(guildId, async (tx) => {
      // The delete takes the row lock, so two finishes of one token cannot both spend it.
      const spent = await tx`delete from identity_enrolments
        where guild_id = ${guildId} and token_hash = ${tokenHash} and expires_at > ${now} returning 1`
      if (spent.length === 0) {
        return false
      }
      await tx`insert into identity_credentials (guild_id, credential_id, public_key, counter, transports)
        values (${guildId}, ${c.id}, ${isoBase64URL.fromBuffer(c.publicKey)}, ${c.counter}, ${c.transports})`
      for (const event of events) {
        await this.append(tx, event)
      }
      return true
    })
  }

  async issueDesktopCode(
    guildId: string,
    code: StoredDesktopCode,
    _now: Date,
    event: IdentityEvent
  ): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`insert into identity_desktop_codes (guild_id, code_hash, expires_at)
        values (${guildId}, ${code.codeHash}, ${code.expiresAt})
        on conflict (guild_id) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at`
      await this.append(tx, event)
    })
  }

  async spendDesktopCode(
    guildId: string,
    codeHash: string,
    _stateHash: string,
    now: Date,
    event: IdentityEvent
  ): Promise<Date | null> {
    return this.db.withGuild(guildId, async (tx) => {
      const spent = await tx`delete from identity_desktop_codes
        where guild_id = ${guildId} and code_hash = ${codeHash} and expires_at > ${now} returning expires_at`
      if (spent.length === 0) {
        return null
      }
      await this.append(tx, event)
      return new Date(now.getTime() + 12 * 60 * 60 * 1000)
    })
  }

  async clearReauth(guildId: string, sessionId: string, hash: string): Promise<boolean> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`update identity_sessions set reauth_hash = null, reauth_expires_at = null
           where guild_id = ${guildId} and session_id = ${sessionId} and reauth_hash = ${hash}
           returning 1`
    )
    return rows.length > 0
  }

  async guildForCredential(credentialId: string) {
    return this.db.guildForCredential(credentialId)
  }

  async saveDiscoverableChallenge(challenge: StoredDiscoverableChallenge, now: Date) {
    await this.db.saveSigninChallenge(challenge, now)
  }

  async takeDiscoverableChallenge(id: string) {
    return this.db.takeSigninChallenge(id)
  }

  async takeChallenge(guildId: string, id: string): Promise<StoredChallenge | null> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`delete from identity_challenges where guild_id = ${guildId} and challenge_id = ${id}
           returning challenge_id, kind, challenge, session_id, founding_hash, expires_at`
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
      foundingHash: row.founding_hash,
      expiresAt: row.expires_at,
    }
  }

  async saveSession(guildId: string, s: StoredSession, event: IdentityEvent): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      await tx`insert into identity_sessions (guild_id, session_id, member_id, token_hash, expires_at)
           values (${guildId}, ${s.id}, ${s.memberId}, ${s.tokenHash}, ${s.expiresAt})`
      await this.append(tx, event)
    })
  }

  async guildMaster(guildId: string): Promise<StoredMember> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select member_id, role from guild_members
           where guild_id = ${guildId} and role = 'guild_master'`
    )
    if (!rows[0]) {
      throw new Error('guild has no Guild Master')
    }
    return toMember(memberRow.parse(rows[0]))
  }

  async findMember(guildId: string, memberId: string): Promise<StoredMember | null> {
    if (!z.uuid().safeParse(memberId).success) {
      return null
    }
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select member_id, role from guild_members
           where guild_id = ${guildId} and member_id = ${memberId}`
    )
    return rows[0] ? toMember(memberRow.parse(rows[0])) : null
  }

  async findSession(guildId: string, tokenHash: string): Promise<StoredSession | null> {
    const rows = await this.db.withGuild(
      guildId,
      (tx) =>
        tx`select session_id, member_id, token_hash, expires_at, reauth_hash, reauth_expires_at
           from identity_sessions where guild_id = ${guildId} and token_hash = ${tokenHash}`
    )
    if (!rows[0]) {
      return null
    }
    const row = sessionRow.parse(rows[0])
    return {
      id: row.session_id,
      memberId: row.member_id,
      tokenHash: row.token_hash,
      expiresAt: row.expires_at,
      reauthHash: row.reauth_hash,
      reauthExpiresAt: row.reauth_expires_at,
    }
  }

  async endSession(
    guildId: string,
    sessionId: string,
    at: Date,
    event: IdentityEvent
  ): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      const ended =
        await tx`update identity_sessions set expires_at = ${at}, reauth_hash = null, reauth_expires_at = null
           where guild_id = ${guildId} and session_id = ${sessionId} returning 1`
      if (ended.length > 0) {
        await this.append(tx, event)
      }
    })
  }

  async setReauth(
    guildId: string,
    sessionId: string,
    hash: string,
    expiresAt: Date,
    event: IdentityEvent
  ): Promise<void> {
    await this.db.withGuild(guildId, async (tx) => {
      const updated =
        await tx`update identity_sessions set reauth_hash = ${hash}, reauth_expires_at = ${expiresAt}
           where guild_id = ${guildId} and session_id = ${sessionId} returning 1`
      if (updated.length === 0) {
        throw new Error('unknown session')
      }
      await this.append(tx, event)
    })
  }
}
