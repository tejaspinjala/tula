import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import {
  type NewSeal,
  SEAL_RESERVATION_MS,
  SEAL_STATUSES,
  SEAL_TTL_MS,
  type Seal,
  type SealPage,
  type SealResult,
  type SealStatus,
  type SealStore,
} from '../ports/seal-store'

const date = z.date().transform((d) => d.toISOString())
const row = z.object({
  seal_id: z.string(),
  quest_id: z.string(),
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
  reserved_until: date.nullable(),
  consumed_at: date.nullable(),
})
type Row = z.infer<typeof row>

const COLUMNS =
  'seal_id, quest_id, requested_by, kind, text, evidence, action_hash, status, requested_at, expires_at, decided_at, decision_note, reserved_until, consumed_at'

function toSeal(r: Row, now: Date): Seal {
  let status: SealStatus = r.status
  let reservedUntil = r.reserved_until
  if (status === 'requested' && Date.parse(r.expires_at) <= now.getTime()) {
    status = 'expired'
  } else if (status === 'reserved' && reservedUntil && Date.parse(reservedUntil) <= now.getTime()) {
    status = 'approved'
    reservedUntil = null
  }
  return {
    id: r.seal_id,
    questId: r.quest_id,
    requestedBy: r.requested_by,
    kind: r.kind,
    text: r.text,
    evidence: r.evidence,
    actionHash: r.action_hash,
    status,
    requestedAt: r.requested_at,
    expiresAt: r.expires_at,
    decidedAt: r.decided_at,
    decisionNote: r.decision_note,
    reservedUntil,
    consumedAt: r.consumed_at,
  }
}

/**
 * Postgres {@link SealStore}: every call runs in `Db.withGuild` (RLS scopes it to one guild) and
 * transitions lock the row, so concurrent callers serialise and exactly one wins. Each transition
 * appends its event (`seal.*`, `post.published_manually`) in the same transaction, with ids and
 * hashes only. Time comes from the injected {@link Clock}.
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
    return this.db.withGuild(guildId, async (tx) => {
      const [inserted] = await tx`
        insert into seals (guild_id, quest_id, requested_by, kind, text, evidence, action_hash,
          requested_at, expires_at)
        values (${guildId}, ${input.questId}, ${input.requestedBy}, ${input.kind}, ${input.text},
          ${input.evidence}, ${input.actionHash}, ${now}, ${expires})
        on conflict (guild_id, quest_id, action_hash) do nothing
        returning ${tx.unsafe(COLUMNS)}`
      if (inserted) {
        const seal = toSeal(row.parse(inserted), now)
        await this.emit(tx, 'seal.requested', seal)
        return seal
      }
      const [existing] = await tx`
        select ${tx.unsafe(COLUMNS)} from seals
        where guild_id = ${guildId} and quest_id = ${input.questId}
          and action_hash = ${input.actionHash}`
      return toSeal(row.parse(existing), now)
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
      // Effective status depends on time, so filter after reading and fetch in id order.
      const seals: Seal[] = []
      let cursor = after
      while (seals.length <= page.limit) {
        const rows = await tx`
          select ${tx.unsafe(COLUMNS)} from seals
          where guild_id = ${guildId} and (${cursor}::uuid is null or seal_id > ${cursor}::uuid)
          order by seal_id limit ${page.limit + 1}`
        for (const r of rows) {
          const seal = toSeal(row.parse(r), now)
          if (page.status === undefined || seal.status === page.status) {
            seals.push(seal)
          }
        }
        const lastRow = rows.at(-1)
        if (rows.length <= page.limit || !lastRow) {
          break
        }
        cursor = row.parse(lastRow).seal_id
      }
      const items = seals.slice(0, page.limit)
      const last = items.at(-1)
      return { seals: items, next: seals.length > page.limit && last ? last.id : null }
    })
  }

  async decide(
    guildId: string,
    id: string,
    decision: { verdict: 'approved' | 'denied'; expectedHash: string; note?: string }
  ): Promise<SealResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const current = await this.lock(tx, guildId, id, now)
      if (!current) {
        return { ok: false, reason: 'not_found' }
      }
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
        tx`status = ${decision.verdict}, decided_at = ${now}, decision_note = ${decision.note ?? null}`
      )
      await this.emit(tx, decision.verdict === 'approved' ? 'seal.approved' : 'seal.denied', seal)
      return { ok: true, seal }
    })
  }

  async reserve(guildId: string, id: string, hash: string): Promise<SealResult> {
    const now = this.clock.now()
    const until = new Date(now.getTime() + SEAL_RESERVATION_MS)
    return this.db.withGuild(guildId, async (tx) => {
      const current = await this.lock(tx, guildId, id, now)
      if (!current) {
        return { ok: false, reason: 'not_found' }
      }
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
        tx`status = 'reserved', reserved_until = ${until}`
      )
      await this.emit(tx, 'seal.reserved', seal)
      return { ok: true, seal }
    })
  }

  consume(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.finishReservation(guildId, id, hash, 'consumed')
  }

  release(guildId: string, id: string, hash: string): Promise<SealResult> {
    return this.finishReservation(guildId, id, hash, 'released')
  }

  private async finishReservation(
    guildId: string,
    id: string,
    hash: string,
    to: 'consumed' | 'released'
  ): Promise<SealResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const current = await this.lock(tx, guildId, id, now)
      if (!current) {
        return { ok: false, reason: 'not_found' }
      }
      if (current.status !== 'reserved') {
        return { ok: false, reason: 'not_reserved' }
      }
      if (current.actionHash !== hash) {
        return { ok: false, reason: 'hash_mismatch' }
      }
      const seal = await this.update(
        tx,
        guildId,
        id,
        now,
        to === 'consumed'
          ? tx`status = 'consumed', reserved_until = null, consumed_at = ${now}`
          : tx`status = 'released', reserved_until = null`
      )
      await this.emit(tx, to === 'consumed' ? 'seal.consumed' : 'seal.released', seal)
      return { ok: true, seal }
    })
  }

  async markPosted(guildId: string, id: string, hash: string): Promise<SealResult> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const current = await this.lock(tx, guildId, id, now)
      if (!current) {
        return { ok: false, reason: 'not_found' }
      }
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
        tx`status = 'consumed', reserved_until = null, consumed_at = ${now}`
      )
      await this.emit(tx, 'seal.consumed', seal)
      await this.emit(tx, 'post.published_manually', seal)
      return { ok: true, seal }
    })
  }

  async expireDue(guildId: string): Promise<number> {
    const now = this.clock.now()
    return this.db.withGuild(guildId, async (tx) => {
      const rows = await tx`
        update seals set status = 'expired'
        where guild_id = ${guildId} and status = 'requested' and expires_at <= ${now}
        returning ${tx.unsafe(COLUMNS)}`
      for (const r of rows) {
        await this.emit(tx, 'seal.expired', toSeal(row.parse(r), now))
      }
      return rows.length
    })
  }

  /** Locks the Seal's row (serialising concurrent transitions) and reads it at `now`. */
  private async lock(tx: TenantTx, guildId: string, id: string, now: Date): Promise<Seal | null> {
    const [found] = await tx`
      select ${tx.unsafe(COLUMNS)} from seals
      where guild_id = ${guildId} and seal_id = ${id} for update`
    return found ? toSeal(row.parse(found), now) : null
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

  /** Events carry ids and hashes only, never the Proposal text or evidence. */
  private async emit(tx: TenantTx, type: string, seal: Seal): Promise<void> {
    await appendEvent(tx, this.keys, type, {
      sealId: seal.id,
      questId: seal.questId,
      actionHash: seal.actionHash,
    })
  }
}
