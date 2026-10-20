import { z } from 'zod'
import { safeEqual } from '../constant-time'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import {
  hashProposal,
  type NewSeal,
  type ReserveResult,
  SEAL_RESERVATION_MS,
  SEAL_STATUSES,
  SEAL_TTL_MS,
  type Seal,
  type SealPage,
  type SealResult,
  type SealStatus,
  type SealStore,
} from '../ports/seal-store'
import { newReservationToken } from './memory-seal-store'

const date = z.date().transform((d) => d.toISOString())
const row = z.object({
  seal_id: z.string(),
  quest_id: z.string(),
  round: z.number().int(),
  requested_by: z.string(),
  kind: z.string(),
  text: z.string(),
  evidence: z.string(),
  action_hash: z.string(),
  status: z.enum(SEAL_STATUSES),
  requested_at: date,
  expires_at: date,
  decided_at: date.nullable(),
  decision_note: z.string().nullable(),
  decided_by: z.string().nullable(),
  reserved_until: date.nullable(),
  consumed_at: date.nullable(),
  reservation_token_hash: z.string().nullable().optional(),
})
type Row = z.infer<typeof row>

const EXPIRE_BATCH = 100
const COLUMNS =
  'seal_id, quest_id, round, requested_by, kind, text, evidence, action_hash, status, requested_at, expires_at, decided_at, decision_note, decided_by, reserved_until, consumed_at'

function toSeal(r: Row, now: Date): Seal {
  let status: SealStatus = r.status
  let stale = false
  if (status === 'requested' && Date.parse(r.expires_at) <= now.getTime()) {
    status = 'expired'
  } else if (
    status === 'reserved' &&
    r.reserved_until &&
    Date.parse(r.reserved_until) <= now.getTime()
  ) {
    stale = true
  }
  return {
    id: r.seal_id,
    questId: r.quest_id,
    requestedBy: r.requested_by,
    kind: r.kind,
    text: r.text,
    evidence: r.evidence,
    round: r.round,
    actionHash: r.action_hash,
    status,
    stale,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    decidedBy: r.decided_by,
    reservedUntil: r.reserved_until,
    consumedAt: r.consumed_at,
  }
}

/**
 * Postgres {@link SealStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild) and
 * transitions lock the row, so concurrent callers serialise and exactly one wins. Each transition
 * appends its event (`seal.*`, `post.published_manually`) in the same transaction, with ids and
 * hashes only. Time comes from the injected {@link Clock}. Reservation tokens are stored only as
 * SHA-256 hashes.
 */
export class PgSealStore implements SealStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    private readonly clock: Clock
  ) {}

  async request(guildId: string, input: NewSeal): Promise<Seal> {
    const now = this.clock.now()
    const expires = new Date(now.getTime() + SEAL_TTL_MS)
    const actionHash = await hashProposal(input.text)
    const round = input.round ?? 1
    return this.db.withGuild(guildId, async (tx) => {
      const [inserted] = await tx`
        insert into seals (guild_id, quest_id, round, requested_by, kind, text, evidence,
          action_hash, requested_at, expires_at)
        values (${guildId}, ${input.questId}, ${round}, ${input.requestedBy}, ${input.kind}, ${input.text},
          ${input.evidence}, ${actionHash}, ${now}, ${expires})
        on conflict (guild_id, quest_id, round, action_hash) do nothing
        returning ${tx.unsafe(COLUMNS)}`
      if (inserted) {
        const seal = toSeal(row.parse(inserted), now)
        await this.emit(tx, 'seal.requested', seal)
        return seal
      }
      const [existing] = await tx`
        select ${tx.unsafe(COLUMNS)} from seals
        where guild_id = ${guildId} and quest_id = ${input.questId}
          and round = ${round} and action_hash = ${actionHash}`
      return toSeal(row.parse(existing), now)
    })
  }

  async forQuest(guildId: string, questId: string): Promise<Seal | null> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select ${tx.unsafe(COLUMNS)} from seals
        where guild_id = ${guildId} and quest_id = ${questId}
        order by round desc, requested_at desc limit 1`
      return found ? toSeal(row.parse(found), now) : null
    })
  }

  async get(guildId: string, id: string): Promise<Seal | null> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const [found] = await tx`
        select ${tx.unsafe(COLUMNS)} from seals where guild_id = ${guildId} and seal_id = ${id}`
      return found ? toSeal(row.parse(found), now) : null
    })
  }

  async list(
    guildId: string,
    page: { after?: string; limit: number; status?: SealStatus }
  ): Promise<SealPage> {
    const now = this.clock.now()
    const after = page.after ?? null
    return this.db.withGuild(guildId, async (tx) => {
      // One indexed query: the time-derived states are predicates, not post-filters.
      const status = page.status
      const wanted =
        status === undefined
          ? tx`true`
          : status === 'requested'
            ? tx`(status = 'requested' and expires_at > ${now})`
            : status === 'expired'
              ? tx`(status = 'expired' or (status = 'requested' and expires_at <= ${now}))`
              : tx`status = ${status}`
      const rows = await tx`
        select ${tx.unsafe(COLUMNS)} from seals
        where guild_id = ${guildId} and ${wanted}
          and (${after}::uuid is null or seal_id > ${after}::uuid)
        order by seal_id limit ${page.limit + 1}`
      const seals = rows.map((r) => toSeal(row.parse(r), now))
      const items = seals.slice(0, page.limit)
      const last = items.at(-1)
      return { seals: items, next: seals.length > page.limit && last ? last.id : null }
    })
  }

  async decide(
    guildId: string,
    id: string,
    decision: {
      verdict: 'approved' | 'denied'
      expectedHash: string
      note?: string
      decidedBy?: string
    }
  ): Promise<SealResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      const current = locked.seal
      if (current.status === 'expired') {
        await this.persistExpiry(tx, guildId, current)
        return { ok: false, reason: 'expired' }
      }
      if (current.status !== 'requested') {
        return { ok: false, reason: 'not_requested' }
      }
      if (current.actionHash !== decision.expectedHash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const seal = await this.update(
        tx,
        guildId,
        id,
        now,
        tx`status = ${decision.verdict}, decided_at = ${now}, decision_note = ${decision.note ?? null}, decided_by = ${decision.decidedBy ?? null}`
      )
      await this.emit(
        tx,
        decision.verdict === 'approved' ? 'seal.approved' : 'seal.denied',
        seal,
        decision.decidedBy ? { decidedBy: decision.decidedBy } : {}
      )
      return { ok: true, seal }
    })
  }

  async reserve(guildId: string, id: string, text: string): Promise<ReserveResult> {
    const now = this.clock.now()
    const until = new Date(now.getTime() + SEAL_RESERVATION_MS)
    const hash = await hashProposal(text)
    const token = newReservationToken()
    const tokenHash = await hashProposal(token)
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      const current = locked.seal
      if (current.status !== 'approved' && current.status !== 'released') {
        return { ok: false, reason: 'not_approved' }
      }
      if (current.actionHash !== hash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const seal = await this.update(
        tx,
        guildId,
        id,
        now,
        tx`status = 'reserved', reserved_until = ${until}, reservation_token_hash = ${tokenHash}`
      )
      await this.emit(tx, 'seal.reserved', seal)
      return { ok: true, seal, token }
    })
  }

  async consume(
    guildId: string,
    id: string,
    use: { text: string; token: string }
  ): Promise<SealResult> {
    const hash = await hashProposal(use.text)
    const tokenHash = await hashProposal(use.token)
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      if (locked.seal.status !== 'reserved') {
        return { ok: false, reason: 'not_reserved' }
      }
      if (locked.tokenHash === null || !safeEqual(locked.tokenHash, tokenHash)) {
        return { ok: false, reason: 'bad_token' }
      }
      if (locked.seal.actionHash !== hash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const seal = await this.update(
        tx,
        guildId,
        id,
        now,
        tx`status = 'consumed', reserved_until = null, reservation_token_hash = null, consumed_at = ${now}`
      )
      await this.emit(tx, 'seal.consumed', seal)
      return { ok: true, seal }
    })
  }

  async release(guildId: string, id: string, use: { token: string }): Promise<SealResult> {
    const tokenHash = await hashProposal(use.token)
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      if (locked.seal.status !== 'reserved') {
        return { ok: false, reason: 'not_reserved' }
      }
      if (locked.tokenHash === null || !safeEqual(locked.tokenHash, tokenHash)) {
        return { ok: false, reason: 'bad_token' }
      }
      return { ok: true, seal: await this.releaseLocked(tx, guildId, id, now) }
    })
  }

  async releaseStale(guildId: string, id: string): Promise<SealResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      if (!locked.seal.stale) {
        return { ok: false, reason: 'not_stale' }
      }
      return { ok: true, seal: await this.releaseLocked(tx, guildId, id, now) }
    })
  }

  private async releaseLocked(tx: TenantTx, guildId: string, id: string, now: Date) {
    const seal = await this.update(
      tx,
      guildId,
      id,
      now,
      tx`status = 'released', reserved_until = null, reservation_token_hash = null`
    )
    await this.emit(tx, 'seal.released', seal)
    return seal
  }

  async markPosted(
    guildId: string,
    id: string,
    text: string,
    auth: { reauthenticated: boolean }
  ): Promise<SealResult> {
    const hash = await hashProposal(text)
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const locked = await this.lock(tx, guildId, id, now)
      if (!locked) {
        return { ok: false, reason: 'not_found' }
      }
      const current = locked.seal
      const usable = current.status === 'approved' || current.status === 'released' || current.stale
      if (!usable) {
        return { ok: false, reason: 'not_approved' }
      }
      if (current.stale && !auth.reauthenticated) {
        return { ok: false, reason: 'not_authorised' }
      }
      if (current.actionHash !== hash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const seal = await this.update(
        tx,
        guildId,
        id,
        now,
        tx`status = 'consumed', reserved_until = null, reservation_token_hash = null, consumed_at = ${now}`
      )
      await this.emit(tx, 'seal.consumed', seal)
      await this.emit(tx, 'post.published_manually', seal)
      return { ok: true, seal }
    })
  }

  async expireDue(guildId: string): Promise<number> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      // Bounded: at most EXPIRE_BATCH per call, so a read never does unbounded writes.
      const rows = await tx`
        update seals set status = 'expired'
        where guild_id = ${guildId} and seal_id in (
          select seal_id from seals
          where guild_id = ${guildId} and status = 'requested' and expires_at <= ${now}
          order by seal_id limit ${EXPIRE_BATCH})
        returning ${tx.unsafe(COLUMNS)}`
      // UPDATE ... RETURNING has no defined order; sort so events land in a stable sequence.
      const expired = rows
        .map((r) => toSeal(row.parse(r), now))
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      for (const seal of expired) {
        await this.emit(tx, 'seal.expired', seal)
      }
      return rows.length
    })
  }

  /** Locks the Seal's row (serialising concurrent transitions) and reads it at `now`. */
  private async lock(
    tx: TenantTx,
    guildId: string,
    id: string,
    now: Date
  ): Promise<{ seal: Seal; tokenHash: string | null } | null> {
    const [found] = await tx`
      select ${tx.unsafe(`${COLUMNS}, reservation_token_hash`)} from seals
      where guild_id = ${guildId} and seal_id = ${id} for update`
    if (!found) {
      return null
    }
    const parsed = row.parse(found)
    return { seal: toSeal(parsed, now), tokenHash: parsed.reservation_token_hash ?? null }
  }

  private async update(
    tx: TenantTx,
    guildId: string,
    id: string,
    now: Date,
    assignments: ReturnType<TenantTx>
  ): Promise<Seal> {
    const [updated] = await tx`
      update seals set ${assignments}
      where guild_id = ${guildId} and seal_id = ${id}
      returning ${tx.unsafe(COLUMNS)}`
    return toSeal(row.parse(updated), now)
  }

  private async persistExpiry(tx: TenantTx, guildId: string, seal: Seal): Promise<void> {
    await tx`
      update seals set status = 'expired' where guild_id = ${guildId} and seal_id = ${seal.id}`
    await this.emit(tx, 'seal.expired', seal)
  }

  /** Events carry ids and hashes only, never the Proposal text, evidence or reservation tokens. */
  private async emit(
    tx: TenantTx,
    type: string,
    seal: Seal,
    extra: Record<string, string> = {}
  ): Promise<void> {
    await appendEvent(tx, this.keys, type, {
      ...extra,
      sealId: seal.id,
      questId: seal.questId,
      actionHash: seal.actionHash,
    })
  }
}
