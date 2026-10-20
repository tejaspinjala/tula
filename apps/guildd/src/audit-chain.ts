import type { TenantTx } from './db/client'
import type { KeyProvider } from './ports/key-provider'

/** The key purpose the chain's MACs are derived under. */
const PURPOSE = 'audit-chain'
/** The `prev_mac` of a guild's first entry. */
const GENESIS = '0'.repeat(64)
const PAGE = 500

/** Result of {@link verifyChain}. */
export type ChainVerdict =
  | { intact: true; entries: number }
  | { intact: false; firstBadSeq: number; reason: string }

type EventRow = { seq: number; type: string; occurredAt: string; payload: unknown }

/** JSON with object keys sorted at every depth, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

async function macOf(
  keys: KeyProvider,
  guildId: string,
  prev: string,
  event: EventRow
): Promise<string> {
  const message = JSON.stringify([
    prev,
    event.seq,
    event.type,
    event.occurredAt,
    canonicalJson(event.payload),
  ])
  return keys.mac(guildId, PURPOSE, new TextEncoder().encode(message))
}

/** Reads events after `afterSeq` with the timestamp at full microsecond precision, in UTC. */
async function eventPage(tx: TenantTx, afterSeq: number): Promise<EventRow[]> {
  const rows = await tx`
    select seq, type, payload,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as occurred_at
    from events where seq > ${afterSeq} order by seq limit ${PAGE}`
  return rows.map((r) => ({
    seq: Number(r.seq),
    type: String(r.type),
    occurredAt: String(r.occurred_at),
    payload: r.payload,
  }))
}

async function guildOf(tx: TenantTx): Promise<string> {
  const [row] = await tx`select current_setting('app.guild_id', true) as guild`
  return String(row?.guild)
}

/**
 * Chains every event that has no entry yet, in seq order, inside the caller's transaction. Safe to
 * call repeatedly: it serialises per guild on an advisory lock and starts from the chain head.
 * Callers append an event and then call this in the same transaction, so the event and its entry
 * commit or roll back together; it also catches up events written by `found_guild`.
 */
export async function extendChain(tx: TenantTx, keys: KeyProvider): Promise<void> {
  const guild = await guildOf(tx)
  await tx`select pg_advisory_xact_lock(hashtextextended(${`audit-chain:${guild}`}, 0))`
  const [head] = await tx`select seq, mac from audit_chain order by seq desc limit 1`
  let lastSeq = Number(head?.seq ?? 0)
  let prev = head ? String(head.mac) : GENESIS
  for (;;) {
    const events = await eventPage(tx, lastSeq)
    if (events.length === 0) {
      return
    }
    for (const event of events) {
      const mac = await macOf(keys, guild, prev, event)
      await tx`insert into audit_chain (guild_id, seq, prev_mac, mac)
        values (${guild}, ${event.seq}, ${prev}, ${mac})`
      prev = mac
      lastSeq = event.seq
    }
  }
}

/**
 * Recomputes the guild's whole chain from its events and reports the first entry that is missing,
 * edited, out of order, unlinked from its predecessor, or has no event behind it.
 */
export async function verifyChain(tx: TenantTx, keys: KeyProvider): Promise<ChainVerdict> {
  const guild = await guildOf(tx)
  let lastSeq = 0
  let prev = GENESIS
  for (;;) {
    const events = await eventPage(tx, lastSeq)
    if (events.length === 0) {
      break
    }
    const entries = await tx`
      select seq, prev_mac, mac from audit_chain
      where seq > ${lastSeq} and seq <= ${events[events.length - 1]?.seq ?? lastSeq}`
    const bySeq = new Map(entries.map((e) => [Number(e.seq), e]))
    for (const event of events) {
      const entry = bySeq.get(event.seq)
      if (!entry) {
        return { intact: false, firstBadSeq: event.seq, reason: 'entry missing' }
      }
      if (String(entry.prev_mac) !== prev) {
        return { intact: false, firstBadSeq: event.seq, reason: 'does not link to previous MAC' }
      }
      const expected = await macOf(keys, guild, prev, event)
      if (String(entry.mac) !== expected) {
        return { intact: false, firstBadSeq: event.seq, reason: 'MAC does not match the event' }
      }
      prev = expected
      lastSeq = event.seq
    }
  }
  const [orphan] = await tx`select seq from audit_chain where seq > ${lastSeq} order by seq limit 1`
  if (orphan) {
    return { intact: false, firstBadSeq: Number(orphan.seq), reason: 'entry has no event' }
  }
  const [count] = await tx`select count(*) as n from audit_chain`
  return { intact: true, entries: Number(count?.n) }
}
