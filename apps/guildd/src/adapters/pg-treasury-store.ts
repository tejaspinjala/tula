import { z } from 'zod'
import type { Db, TenantTx } from '../db/client'
import { appendEvent } from '../events'
import type { Clock } from '../ports/clock'
import type { KeyProvider } from '../ports/key-provider'
import {
  type Balances,
  BUCKETS,
  ENTRY_KINDS,
  type LedgerEntry,
  SPEND_STATUSES,
  type Spend,
  type TreasuryStore,
} from '../ports/treasury-store'
import { TreasuryCore, type TreasuryTx } from '../treasury-core'

/** Advisory-lock namespace for Treasury writes (the model gateway uses 26). */
const LOCK_NAMESPACE = 35

const iso = z.coerce.date().transform((d) => d.toISOString())

const entryRow = z.object({
  seq: z.coerce.number(),
  entry_id: z.string(),
  kind: z.enum(ENTRY_KINDS),
  bucket: z.enum(BUCKETS),
  amount_cents: z.coerce.number(),
  mode: z.literal('paper'),
  spend_id: z.string().nullable(),
  idem_key: z.string().nullable(),
  evidence: z.string().nullable(),
  day: z.string(),
  created_at: iso,
  actor_member: z.string().nullable(),
  prev_hash: z.string(),
  hash: z.string(),
})

const spendRow = z.object({
  spend_id: z.string(),
  seq: z.coerce.number(),
  client_key: z.string(),
  amount_cents: z.coerce.number(),
  settled_cents: z.coerce.number().nullable(),
  purpose: z.string(),
  requested_by: z.string(),
  status: z.enum(SPEND_STATUSES),
  escalation: z.enum(['over_treasurer_limit', 'daily_cap']).nullable(),
  approved_by: z.enum(['treasurer', 'guild_master']).nullable(),
  approved_by_member: z.string().nullable(),
  created_at: iso,
})

const sumRow = z.object({ bucket: z.enum(BUCKETS), total: z.coerce.number() })

const ENTRY_COLUMNS = `seq, entry_id, kind, bucket, amount_cents, mode, spend_id, idem_key,
  evidence, actor_member, day::text as day, created_at, prev_hash, hash`

function toEntry(raw: unknown): LedgerEntry {
  const r = entryRow.parse(raw)
  return {
    seq: r.seq,
    id: r.entry_id,
    kind: r.kind,
    bucket: r.bucket,
    amountCents: r.amount_cents,
    mode: r.mode,
    spendId: r.spend_id,
    idemKey: r.idem_key,
    evidence: r.evidence,
    actorMember: r.actor_member,
    day: r.day,
    createdAt: r.created_at,
    prevHash: r.prev_hash,
    hash: r.hash,
  }
}

function toSpend(raw: unknown): Spend {
  const r = spendRow.parse(raw)
  return {
    id: r.spend_id,
    seq: r.seq,
    key: r.client_key,
    amountCents: r.amount_cents,
    settledCents: r.settled_cents,
    purpose: r.purpose,
    requestedBy: r.requested_by,
    status: r.status,
    escalation: r.escalation,
    approvedBy: r.approved_by,
    approvedByMember: r.approved_by_member,
    createdAt: r.created_at,
  }
}

/**
 * Postgres {@link TreasuryStore}. Every call runs in `Db.withGuild` (RLS scopes it to one guild);
 * a write first takes a per-guild transaction advisory lock, so the balance and cap checks and
 * the ledger append are one atomic step and concurrent requests serialise instead of overspending.
 * Each ledger entry and spend change appends a chained event (ids and amounts only) in the same
 * transaction. The rules live in {@link TreasuryCore}, shared with the memory adapter.
 */
export class PgTreasuryStore extends TreasuryCore implements TreasuryStore {
  constructor(
    private readonly db: Db,
    private readonly keys: KeyProvider,
    clock: Clock
  ) {
    super(clock)
  }

  protected run<T>(
    guildId: string,
    mode: 'read' | 'write',
    fn: (tx: TreasuryTx) => Promise<T>
  ): Promise<T> {
    return this.db.withGuild(guildId, async (tx) => {
      if (mode === 'write') {
        await tx`select pg_advisory_xact_lock(hashtextextended(${guildId}, ${LOCK_NAMESPACE}))`
      }
      return fn(this.txFor(tx, guildId))
    })
  }

  private txFor(tx: TenantTx, guildId: string): TreasuryTx {
    return {
      lastEntry: async () => {
        const [row] = await tx.unsafe(
          `select ${ENTRY_COLUMNS} from treasury_ledger where guild_id = $1
           order by seq desc limit 1`,
          [guildId]
        )
        return row ? toEntry(row) : null
      },
      balances: async () => {
        const rows = await tx`
          select bucket, coalesce(sum(amount_cents), 0) as total
          from treasury_ledger where guild_id = ${guildId} group by bucket`
        const sums: Balances = { operating: 0, reserve: 0, profit: 0 }
        for (const raw of rows) {
          const r = sumRow.parse(raw)
          sums[r.bucket] = r.total
        }
        return sums
      },
      // A refund (settle or release) counts against the day its spend was RESERVED on, so a
      // refund after UTC midnight can never open headroom in the new day's cap.
      spentOn: async (day) => {
        const [row] = await tx`
          select coalesce(-sum(l.amount_cents), 0) as spent
          from treasury_ledger l
          left join treasury_ledger r
            on r.guild_id = l.guild_id and r.spend_id = l.spend_id and r.kind = 'spend_reserve'
          where l.guild_id = ${guildId} and l.bucket = 'operating'
            and l.kind in ('spend_reserve', 'spend_settle', 'spend_release')
            and (case when l.kind = 'spend_reserve' then l.day else r.day end) = ${day}::date`
        return z.object({ spent: z.coerce.number() }).parse(row).spent
      },
      entriesByKey: async (key) =>
        (
          await tx.unsafe(
            `select ${ENTRY_COLUMNS} from treasury_ledger
             where guild_id = $1 and idem_key = $2 order by seq`,
            [guildId, key]
          )
        ).map(toEntry),
      append: async (e) => {
        await tx`
          insert into treasury_ledger
            (guild_id, seq, entry_id, kind, bucket, amount_cents, mode, spend_id, idem_key,
             evidence, actor_member, day, created_at, prev_hash, hash)
          values (${guildId}, ${e.seq}, ${e.id}, ${e.kind}, ${e.bucket}, ${e.amountCents},
                  ${e.mode}, ${e.spendId}, ${e.idemKey}, ${e.evidence}, ${e.actorMember}, ${e.day}::date,
                  ${e.createdAt}, ${e.prevHash}, ${e.hash})`
      },
      entriesAfter: async (after, limit) =>
        (
          await tx.unsafe(
            `select ${ENTRY_COLUMNS} from treasury_ledger
             where guild_id = $1 and seq > $2 order by seq limit $3`,
            [guildId, after, limit]
          )
        ).map(toEntry),
      spendByKey: async (key) => {
        const [row] = await tx`
          select * from treasury_spends where guild_id = ${guildId} and client_key = ${key}`
        return row ? toSpend(row) : null
      },
      spendById: async (id) => {
        if (!z.uuid().safeParse(id).success) {
          return null
        }
        const [row] = await tx`
          select * from treasury_spends where guild_id = ${guildId} and spend_id = ${id}`
        return row ? toSpend(row) : null
      },
      spendsAfter: async (after, limit) =>
        (
          await tx`
            select * from treasury_spends where guild_id = ${guildId} and seq > ${after}
            order by seq limit ${limit}`
        ).map(toSpend),
      insertSpend: async (s) => {
        const [row] = await tx`
          insert into treasury_spends
            (guild_id, spend_id, client_key, amount_cents, settled_cents, purpose, requested_by,
             status, escalation, approved_by, approved_by_member, created_at)
          values (${guildId}, ${s.id}, ${s.key}, ${s.amountCents}, ${s.settledCents}, ${s.purpose},
                  ${s.requestedBy}, ${s.status}, ${s.escalation}, ${s.approvedBy}, ${s.approvedByMember}, ${s.createdAt})
          returning *`
        return toSpend(row)
      },
      updateSpend: async (s) => {
        await tx`
          update treasury_spends set status = ${s.status}, settled_cents = ${s.settledCents},
            escalation = ${s.escalation}, approved_by = ${s.approvedBy},
            approved_by_member = ${s.approvedByMember}
          where guild_id = ${guildId} and spend_id = ${s.id}`
      },
      emit: async (type, payload) => {
        await appendEvent(tx, this.keys, type, payload)
      },
    }
  }
}
