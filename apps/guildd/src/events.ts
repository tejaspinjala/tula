import type { JSONValue } from 'postgres'
import { extendChain } from './audit-chain'
import type { TenantTx } from './db/client'
import type { KeyProvider } from './ports/key-provider'

/** One entry of a guild's append-only event log. */
export interface GuildEvent {
  /** Per-guild monotonic, gap-free sequence number, starting at 1. */
  seq: number
  type: string
  payload: unknown
  occurredAt: string
}

/**
 * Appends an event to the tenant's log inside the caller's transaction (the transactional outbox:
 * the event commits or rolls back with the state change it describes) and chains it into the
 * guild's keyed audit chain in the same transaction, with the MAC key from `keys`.
 * @returns the event's seq.
 */
export async function appendEvent(
  tx: TenantTx,
  keys: KeyProvider,
  type: string,
  payload: JSONValue
): Promise<number> {
  const [row] = await tx`select append_event(${type}, ${tx.json(payload)}) as seq`
  await extendChain(tx, keys)
  return Number(row?.seq)
}

/** Reads up to `limit` events with seq greater than `lastSeq`, in seq order. */
export async function eventsAfter(
  tx: TenantTx,
  lastSeq: number,
  limit = 100
): Promise<GuildEvent[]> {
  const rows = await tx`
    select seq, type, payload, occurred_at from events
    where seq > ${lastSeq} order by seq limit ${limit}`
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    payload: r.payload,
    occurredAt: new Date(r.occurred_at).toISOString(),
  }))
}

/** Where a replay stops: after a seq, or after an instant. */
export type EventBound = { seq: number } | { time: string } | null

/**
 * One page of the log for replay: events with seq greater than `after`, up to `limit`, no later
 * than `bound`. `next` is the cursor for the following page, null when the page reaches the bound.
 */
export async function eventsHistory(
  tx: TenantTx,
  after: number,
  limit: number,
  bound: EventBound
): Promise<{ events: GuildEvent[]; next: number | null }> {
  const untilSeq = bound && 'seq' in bound ? bound.seq : Number.MAX_SAFE_INTEGER
  const untilTime = bound && 'time' in bound ? bound.time : '9999-12-31T23:59:59.999Z'
  const rows = await tx`
    select seq, type, payload, occurred_at from events
    where seq > ${after} and seq <= ${untilSeq} and occurred_at <= ${untilTime}
    order by seq limit ${limit + 1}`
  const events = rows.slice(0, limit).map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    payload: r.payload,
    occurredAt: new Date(r.occurred_at).toISOString(),
  }))
  return { events, next: rows.length > limit ? (events.at(-1)?.seq ?? null) : null }
}

/** The highest seq in the tenant's log, 0 when empty. */
export async function headSeq(tx: TenantTx): Promise<number> {
  const [row] = await tx`select coalesce(max(seq), 0) as seq from events`
  return Number(row?.seq)
}
