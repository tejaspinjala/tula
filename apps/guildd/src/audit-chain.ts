import type { TenantTx } from './db/client'
import type { CheckpointAnchor } from './ports/checkpoint-anchor'
import type { KeyProvider } from './ports/key-provider'

/** The key purpose the chain's MACs are derived under. */
const PURPOSE = 'audit-chain'
/** The key purpose checkpoint signatures are made under. */
const CHECKPOINT_PURPOSE = 'audit-checkpoint'
/** The key purpose resume cursors are signed under. */
const CURSOR_PURPOSE = 'audit-cursor'
/** The `prev_mac` of a guild's first entry. */
const GENESIS = '0'.repeat(64)
const PAGE = 500
/** Most entries one verify call replays, whatever limit the caller asks for. */
export const MAX_VERIFY_ENTRIES = 5000
/** Milliseconds each statement of a verify transaction may run before Postgres cancels it. */
const VERIFY_STATEMENT_TIMEOUT_MS = 15_000

/**
 * Result of {@link verifyChain}. A `partial` verdict found no tampering up to `verifiedThrough`
 * but stopped at its limit: resume with `cursor`. Only a verdict with `entries` covers the rest.
 */
export type ChainVerdict =
  | { intact: true; entries: number }
  | { intact: true; partial: true; verifiedThrough: number; cursor: string }
  | { intact: false; firstBadSeq: number; reason: string }

type EventRow = { seq: number; type: string; occurredAt: string; payload: unknown }
type Bad = { intact: false; firstBadSeq: number; reason: string }
type Position = { seq: number; mac: string }

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

type Signer = (data: Uint8Array) => Promise<string>

async function macOf(sign: Signer, prev: string, event: EventRow): Promise<string> {
  const message = JSON.stringify([
    prev,
    event.seq,
    event.type,
    event.occurredAt,
    canonicalJson(event.payload),
  ])
  return sign(new TextEncoder().encode(message))
}

/** Reads events after `afterSeq` with the timestamp at full microsecond precision, in UTC. */
async function eventPage(tx: TenantTx, afterSeq: number, size = PAGE): Promise<EventRow[]> {
  const rows = await tx`
    select seq, type, payload,
      to_char(occurred_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') as occurred_at
    from events where seq > ${afterSeq} order by seq limit ${size}`
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
  const sign = await keys.macFor(guild, PURPOSE)
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
      const mac = await macOf(sign, prev, event)
      await tx`insert into audit_chain (guild_id, seq, prev_mac, mac)
        values (${guild}, ${event.seq}, ${prev}, ${mac})`
      prev = mac
      lastSeq = event.seq
    }
  }
}

/** Bounds every statement of the calling verify transaction; transaction-local, so nothing leaks. */
export async function bindVerifyTimeout(tx: TenantTx): Promise<void> {
  await tx`select set_config('statement_timeout', ${String(VERIFY_STATEMENT_TIMEOUT_MS)}, true)`
}

/** Raised when a resume cursor is malformed or was not issued by this guild's verify. */
export class InvalidCursorError extends Error {
  constructor() {
    super('invalid cursor')
    this.name = 'InvalidCursorError'
  }
}

const encode = (text: string) => new TextEncoder().encode(text)

/** The signature a checkpoint of `guild` at (`seq`, `mac`) carries. */
export function checkpointSignature(
  keys: KeyProvider,
  guild: string,
  seq: number,
  mac: string
): Promise<string> {
  return keys.mac(guild, CHECKPOINT_PURPOSE, encode(`${guild}:${seq}:${mac}`))
}

async function cursorFor(keys: KeyProvider, guild: string, at: Position): Promise<string> {
  const sig = await keys.mac(guild, CURSOR_PURPOSE, encode(`${guild}:${at.seq}:${at.mac}`))
  return `${at.seq}.${at.mac}.${sig}`
}

async function readCursor(keys: KeyProvider, guild: string, cursor: string): Promise<Position> {
  const [seq, mac, sig, extra] = cursor.split('.')
  const n = Number(seq)
  if (extra !== undefined || !mac || !Number.isSafeInteger(n) || n < 1) {
    throw new InvalidCursorError()
  }
  if ((await cursorFor(keys, guild, { seq: n, mac })) !== `${n}.${mac}.${sig}`) {
    throw new InvalidCursorError()
  }
  return { seq: n, mac }
}

/** Options of {@link verifyChain}. */
export interface VerifyOptions {
  /** Most entries to replay in this call; defaults to and is capped at {@link MAX_VERIFY_ENTRIES}. */
  limit?: number
  /** Resume point from an earlier partial verdict. */
  cursor?: string
  /** Replay from the first entry instead of the latest checkpoint. */
  full?: boolean
}

/** Checks the anchored checkpoint is genuine and still in the chain: the truncation test. */
async function checkAnchor(
  tx: TenantTx,
  keys: KeyProvider,
  anchor: CheckpointAnchor,
  guild: string
): Promise<Bad | null> {
  const anchored = await anchor.latest(guild)
  if (!anchored) {
    return null
  }
  if ((await checkpointSignature(keys, guild, anchored.seq, anchored.mac)) !== anchored.signature) {
    return {
      intact: false,
      firstBadSeq: anchored.seq,
      reason: 'anchored checkpoint signature invalid',
    }
  }
  const [entry] = await tx`select mac from audit_chain where seq = ${anchored.seq}`
  if (!entry || String(entry.mac) !== anchored.mac) {
    return {
      intact: false,
      firstBadSeq: anchored.seq,
      reason: 'chain no longer contains the anchored checkpoint (truncated or rewritten)',
    }
  }
  return null
}

/** The latest stored checkpoint, checked for its signature and for agreement with the chain. */
async function startFromCheckpoint(
  tx: TenantTx,
  keys: KeyProvider,
  guild: string
): Promise<Position | Bad> {
  const [row] = await tx`
    select seq, mac, signature from audit_checkpoints order by seq desc limit 1`
  if (!row) {
    return { seq: 0, mac: GENESIS }
  }
  const at = { seq: Number(row.seq), mac: String(row.mac) }
  if ((await checkpointSignature(keys, guild, at.seq, at.mac)) !== String(row.signature)) {
    return { intact: false, firstBadSeq: at.seq, reason: 'checkpoint signature invalid' }
  }
  const [entry] = await tx`select mac from audit_chain where seq = ${at.seq}`
  if (!entry || String(entry.mac) !== at.mac) {
    return { intact: false, firstBadSeq: at.seq, reason: 'checkpoint does not match the chain' }
  }
  return at
}

/**
 * Like {@link verifyChain}, also returning the chain position the call verified up to, which is
 * what a checkpoint may sign.
 */
export async function verifyFrom(
  tx: TenantTx,
  keys: KeyProvider,
  anchor: CheckpointAnchor,
  options: VerifyOptions = {}
): Promise<{ verdict: ChainVerdict; position: Position }> {
  await bindVerifyTimeout(tx)
  const guild = await guildOf(tx)
  const limit = Math.min(Math.max(options.limit ?? MAX_VERIFY_ENTRIES, 1), MAX_VERIFY_ENTRIES)
  const bad = (v: Bad) => ({ verdict: v, position: { seq: 0, mac: GENESIS } })
  const anchorProblem = await checkAnchor(tx, keys, anchor, guild)
  if (anchorProblem) {
    return bad(anchorProblem)
  }
  let start: Position | Bad
  if (options.cursor !== undefined) {
    start = await readCursor(keys, guild, options.cursor)
  } else if (options.full) {
    start = { seq: 0, mac: GENESIS }
  } else {
    start = await startFromCheckpoint(tx, keys, guild)
  }
  if ('intact' in start) {
    return bad(start)
  }
  const sign = await keys.macFor(guild, PURPOSE)
  let lastSeq = start.seq
  let prev = start.mac
  let done = 0
  for (;;) {
    const room = limit - done
    const events = await eventPage(tx, lastSeq, Math.min(PAGE, Math.max(room, 1)))
    if (events.length === 0) {
      break
    }
    if (room <= 0) {
      const at = { seq: lastSeq, mac: prev }
      const cursor = await cursorFor(keys, guild, at)
      return {
        verdict: { intact: true, partial: true, verifiedThrough: lastSeq, cursor },
        position: at,
      }
    }
    const entries = await tx`
      select seq, prev_mac, mac from audit_chain
      where seq > ${lastSeq} and seq <= ${events[events.length - 1]?.seq ?? lastSeq}`
    const bySeq = new Map(entries.map((e) => [Number(e.seq), e]))
    for (const event of events) {
      const entry = bySeq.get(event.seq)
      if (!entry) {
        return bad({ intact: false, firstBadSeq: event.seq, reason: 'entry missing' })
      }
      if (String(entry.prev_mac) !== prev) {
        return bad({
          intact: false,
          firstBadSeq: event.seq,
          reason: 'does not link to previous MAC',
        })
      }
      const expected = await macOf(sign, prev, event)
      if (String(entry.mac) !== expected) {
        return bad({
          intact: false,
          firstBadSeq: event.seq,
          reason: 'MAC does not match the event',
        })
      }
      prev = expected
      lastSeq = event.seq
      done++
    }
  }
  const [orphan] = await tx`select seq from audit_chain where seq > ${lastSeq} order by seq limit 1`
  if (orphan) {
    return bad({ intact: false, firstBadSeq: Number(orphan.seq), reason: 'entry has no event' })
  }
  const [count] = await tx`select count(*) as n from audit_chain`
  return {
    verdict: { intact: true, entries: Number(count?.n) },
    position: { seq: lastSeq, mac: prev },
  }
}

/**
 * Replays the guild's chain from its events and reports the first entry that is missing, edited,
 * out of order, unlinked from its predecessor, or has no event behind it. It starts from the
 * latest signed checkpoint (everything before it was verified when the Guild Master signed it)
 * unless `full` or a `cursor` says otherwise, replays at most `limit` entries, and then returns a
 * partial verdict with a signed cursor to resume from. The latest checkpoint anchored outside
 * Postgres must still be in the chain, which is how truncation of the newest entries is caught.
 * The key is resolved once per call and the transaction gets a statement timeout.
 */
export async function verifyChain(
  tx: TenantTx,
  keys: KeyProvider,
  anchor: CheckpointAnchor,
  options: VerifyOptions = {}
): Promise<ChainVerdict> {
  return (await verifyFrom(tx, keys, anchor, options)).verdict
}

/** Outcome of {@link signCheckpoint}. */
export type CheckpointOutcome =
  | { ok: true; seq: number; mac: string; signature: string; complete: boolean }
  | { ok: false; verdict: Bad }

/**
 * Verifies the chain (from the latest checkpoint, at most `limit` entries), then records the
 * position reached as a signed checkpoint and publishes it to the anchor. A checkpoint never
 * vouches for entries that were not verified. Idempotent per position.
 */
export async function signCheckpoint(
  tx: TenantTx,
  keys: KeyProvider,
  anchor: CheckpointAnchor,
  options: { limit?: number } = {}
): Promise<CheckpointOutcome> {
  const guild = await guildOf(tx)
  const { verdict, position } = await verifyFrom(tx, keys, anchor, options)
  if (!verdict.intact) {
    return { ok: false, verdict }
  }
  if (position.seq < 1) {
    return {
      ok: false,
      verdict: { intact: false, firstBadSeq: 0, reason: 'nothing to checkpoint' },
    }
  }
  const signature = await checkpointSignature(keys, guild, position.seq, position.mac)
  await tx`insert into audit_checkpoints (guild_id, seq, mac, signature)
    values (${guild}, ${position.seq}, ${position.mac}, ${signature})
    on conflict (guild_id, seq) do nothing`
  await anchor.publish(guild, { seq: position.seq, mac: position.mac, signature })
  return { ok: true, ...position, signature, complete: !('partial' in verdict) }
}
