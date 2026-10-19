// Human-approval log (P0-4). Replaces the old file-per-approval queue under engine/approvals/.
//
// Storage: one hash-chained JSONL log, `<dir>/approvals.jsonl` (default dir: $FLEET_HOME/approvals,
// outside the repo tree agents write to), plus `<dir>/approvals.head.json` = the last {seq, hash}
// we appended, so cutting lines off the end is detected. Every mutation runs under one mutex
// (`<dir>/approvals.mutex.lock`): verify chain -> replay -> check transition -> append -> write head.
//
// State is never stored, only derived by replaying the chain:
//   requested(pending) -> approved | denied | expired
//   approved|released  -> reserved(token, lease)        reserve(actionHash) at PreToolUse
//   reserved           -> consumed (usesLeft 0)          consume(token) on PostToolUse success
//   reserved           -> released (usable again)        release(token) on failure
//   reserved, lease lapsed -> approved again             a crash cannot burn or leak an approval
// An approval is bound to actionHash = sha256(canonical {tool, input}); a different input does not match.
//
// Fail closed: if the chain does not verify (tampered line, forged line, truncation vs the recorded
// head, bad payload) every read and write throws ApprovalError('chain_invalid'), so nothing is authorised.
// A chain-valid event that is not a legal transition (e.g. decided by its requester) is ignored on replay.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { approvalSchema, type Approval } from '../schema/approval.ts';
import { append, canonicalJson, verify, type JsonValue } from './chain.ts';
import { withLock, type LockOptions } from './lock.ts';
import { readOptional, write } from './store.ts';
import { fleetPath } from './paths.ts';
import { newId } from './ids.ts';

export const DEFAULT_TTL_MS = 72 * 3600_000;
export const DEFAULT_LEASE_MS = 10 * 60_000;
export const OWNER = 'owner';

export const LOG_NAME = 'approvals.jsonl';
export const HEAD_NAME = 'approvals.head.json';
const MUTEX_NAME = 'approvals.mutex';

export type ApprovalErrorCode =
  | 'chain_invalid'
  | 'not_found'
  | 'not_pending'
  | 'expired'
  | 'self_approval'
  | 'wrong_approver'
  | 'bad_request'
  | 'inside_project';

export class ApprovalError extends Error {
  constructor(public readonly code: ApprovalErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ApprovalError';
  }
}

export interface ApprovalOptions {
  /** Directory holding the log. Default `$FLEET_HOME/approvals`. */
  dir?: string;
  /** Clock (tests). Also stamps chain entries, whose ts is the authoritative event time. */
  now?: () => Date;
  /** Reservation lease. Default 10 min. */
  leaseMs?: number;
  lock?: LockOptions;
}

export interface Reservation {
  approvalId: string;
  token: string;
  actionHash: string;
  toolUseId?: string;
  reservedAt: string;
  leaseUntil: string;
}

export interface ApprovalState {
  approval: Approval;
  /** Live reservation (status 'reserved' and lease not lapsed). */
  reservation?: Reservation;
}

// ---- chain payloads (log records, not entities: the entity is approvalSchema) ----
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const token = z.string().regex(/^[a-f0-9]{32}$/);
const recordSchema = z.discriminatedUnion('type', [
  z.strictObject({ v: z.literal(1), type: z.literal('requested'), approval: approvalSchema }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('decided'),
    id: z.string(),
    decision: z.enum(['approved', 'denied']),
    decidedBy: z.string().min(1),
    reason: z.string().optional(),
  }),
  z.strictObject({
    v: z.literal(1),
    type: z.literal('reserved'),
    id: z.string(),
    token,
    actionHash: sha256,
    toolUseId: z.string().optional(),
    leaseUntil: z.iso.datetime({ offset: true }),
  }),
  z.strictObject({ v: z.literal(1), type: z.literal('consumed'), id: z.string(), token }),
  z.strictObject({ v: z.literal(1), type: z.literal('released'), id: z.string(), token, reason: z.string().optional() }),
]);
type ApprovalRecord = z.infer<typeof recordSchema>;
const headSchema = z.strictObject({ seq: z.int().min(1), hash: sha256 });

/** sha256 of canonical JSON {tool, input}: the hash an approval is bound to. Key order does not matter. */
export function actionHash(tool: string, input: unknown): string {
  const plain: unknown = JSON.parse(JSON.stringify(input ?? {}));
  return crypto.createHash('sha256').update(canonicalJson({ tool, input: plain })).digest('hex');
}

/** Absolute approvals dir. Refuses a dir inside $CLAUDE_PROJECT_DIR (the tree agents write to). */
export function approvalsDir(opts: ApprovalOptions = {}): string {
  const dir = path.resolve(opts.dir ?? fleetPath('approvals'));
  const proj = process.env.CLAUDE_PROJECT_DIR;
  if (proj) {
    const real = (p: string) => {
      try { return fs.realpathSync(p); } catch { return path.resolve(p); }
    };
    const r = real(proj);
    const d = real(dir);
    if (d === r || d.startsWith(r + path.sep)) {
      throw new ApprovalError('inside_project', `approvals dir ${d} is inside the project tree ${r}; set FLEET_HOME elsewhere`);
    }
  }
  return dir;
}

const files = (opts: ApprovalOptions) => {
  const dir = approvalsDir(opts);
  return { dir, log: path.join(dir, LOG_NAME), head: path.join(dir, HEAD_NAME), mutex: path.join(dir, MUTEX_NAME) };
};
const nowOf = (opts: ApprovalOptions) => (opts.now ?? (() => new Date()))();
const ms = (iso: string) => Date.parse(iso);

// ---- replay ----
interface Internal {
  approval: Approval;
  /** Latest reservation, live or lapsed. Cleared by release. */
  lastRes?: Reservation;
}

type Entry = { seq: number; ts: string; payload: unknown };

function readEntries(log: string): Entry[] {
  if (!fs.existsSync(log)) return [];
  const text = fs.readFileSync(log, 'utf8');
  return text.split('\n').filter((l) => l.length > 0).map((l) => JSON.parse(l) as Entry);
}

/** Verifies the chain (against the recorded head) and replays it. Throws chain_invalid on any doubt. */
function load(opts: ApprovalOptions, headRec: { seq: number; hash: string } | undefined): Map<string, Internal> {
  const { log } = files(opts);
  const res = verify(log, headRec ? { expect: headRec } : {});
  if (!res.ok) throw new ApprovalError('chain_invalid', `approvals log failed verification at seq ${res.atSeq}: ${res.reason} (${res.detail})`);
  if (!headRec && res.count > 1) throw new ApprovalError('chain_invalid', 'approvals head record is missing');
  const state = new Map<string, Internal>();
  for (const e of readEntries(log)) {
    const parsed = recordSchema.safeParse(e.payload);
    if (!parsed.success) throw new ApprovalError('chain_invalid', `seq ${e.seq}: payload is not a valid approval record`);
    apply(state, parsed.data, e.ts);
  }
  return state;
}

/** Applies one record at time `ts`. Illegal transitions are ignored (they cannot come from this module). */
function apply(state: Map<string, Internal>, r: ApprovalRecord, ts: string): void {
  const t = ms(ts);
  if (r.type === 'requested') {
    const a = r.approval;
    if (state.has(a.id) || a.status !== 'pending' || a.usesLeft !== 1 || a.decidedBy || a.requestedBy === OWNER) return;
    state.set(a.id, { approval: { ...a } });
    return;
  }
  const cur = state.get(r.id);
  if (!cur) return;
  const a = cur.approval;
  const leaseLive = (res: Reservation | undefined) => !!res && a.status === 'reserved' && t < ms(res.leaseUntil);
  switch (r.type) {
    case 'decided':
      if (a.status !== 'pending' || t >= ms(a.expiresAt)) return;
      if (r.decidedBy === a.requestedBy || r.decidedBy !== a.approverRequired) return;
      cur.approval = { ...a, status: r.decision, decidedBy: r.decidedBy, decidedAt: ts, ...(r.reason ? { reason: r.reason } : {}) };
      return;
    case 'reserved': {
      const usable = a.status === 'approved' || a.status === 'released' || (a.status === 'reserved' && !leaseLive(cur.lastRes));
      if (!usable || a.usesLeft !== 1 || t >= ms(a.expiresAt) || r.actionHash !== a.actionHash) return;
      cur.approval = { ...a, status: 'reserved' };
      cur.lastRes = {
        approvalId: a.id, token: r.token, actionHash: r.actionHash, reservedAt: ts, leaseUntil: r.leaseUntil,
        ...(r.toolUseId ? { toolUseId: r.toolUseId } : {}),
      };
      return;
    }
    case 'consumed':
      // The latest reservation's token may consume even after its lease lapsed (the action did run),
      // as long as nobody re-reserved in between.
      if (a.status !== 'reserved' || cur.lastRes?.token !== r.token) return;
      cur.approval = { ...a, status: 'consumed', usesLeft: 0 };
      return;
    case 'released':
      if (a.status !== 'reserved' || cur.lastRes?.token !== r.token) return;
      cur.approval = { ...a, status: 'released' };
      delete cur.lastRes;
      return;
  }
}

/** Status as of `now`: applies time-based expiry and lease lapse. */
function view(i: Internal, now: Date): ApprovalState {
  const t = now.getTime();
  const a = i.approval;
  const expired = t >= ms(a.expiresAt);
  if (a.status === 'reserved' && i.lastRes) {
    if (t < ms(i.lastRes.leaseUntil)) return { approval: a, reservation: i.lastRes };
    return { approval: { ...a, status: expired ? 'expired' : 'approved' } };
  }
  if (expired && (a.status === 'pending' || a.status === 'approved' || a.status === 'released')) {
    return { approval: { ...a, status: 'expired' } };
  }
  return { approval: a };
}

// ---- locked mutation ----
async function mutate<T>(opts: ApprovalOptions, fn: (state: Map<string, Internal>, now: Date, add: (r: ApprovalRecord) => Promise<void>) => Promise<T>): Promise<T> {
  const f = files(opts);
  fs.mkdirSync(f.dir, { recursive: true, mode: 0o700 });
  return withLock(f.mutex, async () => {
    const headRec = await readOptional(f.head, headSchema).catch(() => {
      throw new ApprovalError('chain_invalid', 'approvals head record is unreadable');
    });
    const state = load(opts, headRec);
    const now = nowOf(opts);
    const add = async (r: ApprovalRecord) => {
      recordSchema.parse(r);
      const entry = await append(f.log, r as unknown as JsonValue, { ...opts.lock, now: () => now });
      await write(f.head, { seq: entry.seq, hash: entry.hash }, headSchema, opts.lock);
      apply(state, r, entry.ts);
    };
    return fn(state, now, add);
  }, opts.lock);
}

async function snapshot(opts: ApprovalOptions): Promise<Map<string, Internal>> {
  // Under the mutex too, so a reader never sees a half-written last line.
  return mutate(opts, async (state) => state);
}

// ---- public API ----
export interface RequestInput {
  actionHash: string;
  summary: string;
  requestedBy: string;
  kind?: Approval['kind'];
  approverRequired?: string;
  ttlMs?: number;
  taskId?: string;
}

/**
 * Records a pending approval for actionHash. If an open one (pending/approved/reserved/released,
 * not expired) already exists for the same hash, returns it instead of creating a duplicate.
 */
export async function request(input: RequestInput, opts: ApprovalOptions = {}): Promise<Approval> {
  if (!/^[a-f0-9]{64}$/.test(input.actionHash)) throw new ApprovalError('bad_request', 'actionHash must be sha256 hex');
  if (!input.requestedBy || input.requestedBy === OWNER) throw new ApprovalError('bad_request', `requestedBy may not be "${OWNER}"`);
  return mutate(opts, async (state, now, add) => {
    for (const i of state.values()) {
      const v = view(i, now).approval;
      if (v.actionHash === input.actionHash && ['pending', 'approved', 'reserved', 'released'].includes(v.status)) return v;
    }
    const summary = (input.summary.replace(/\s+/g, ' ').trim() || '(no summary)').slice(0, 400);
    const approval = approvalSchema.parse({
      id: newId('apr', now.getTime()),
      kind: input.kind ?? 'external',
      actionHash: input.actionHash,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      summary,
      requestedBy: input.requestedBy,
      approverRequired: input.approverRequired ?? OWNER,
      status: 'pending',
      usesLeft: 1,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (input.ttlMs ?? DEFAULT_TTL_MS)).toISOString(),
    });
    await add({ v: 1, type: 'requested', approval });
    return approval;
  });
}

/**
 * Approve or deny a pending approval. decidedBy must be the approval's approverRequired and must
 * differ from requestedBy. Only engine/bin/approve.ts (owner CLI) calls this, with decidedBy 'owner'.
 */
export async function decide(id: string, decision: 'approved' | 'denied', decidedBy: string, reason?: string, opts: ApprovalOptions = {}): Promise<Approval> {
  return mutate(opts, async (state, now, add) => {
    const i = state.get(id);
    if (!i) throw new ApprovalError('not_found', `no approval ${id}`);
    const v = view(i, now).approval;
    if (v.status === 'expired') throw new ApprovalError('expired', `approval ${id} expired at ${v.expiresAt}`);
    if (v.status !== 'pending') throw new ApprovalError('not_pending', `approval ${id} is ${v.status}`);
    if (decidedBy === v.requestedBy) throw new ApprovalError('self_approval', `approval ${id} cannot be decided by its requester (${decidedBy})`);
    if (decidedBy !== v.approverRequired) throw new ApprovalError('wrong_approver', `approval ${id} needs ${v.approverRequired}, not ${decidedBy}`);
    await add({ v: 1, type: 'decided', id, decision, decidedBy, ...(reason ? { reason } : {}) });
    return state.get(id)!.approval;
  });
}

export const approve = (id: string, decidedBy: string, opts: ApprovalOptions = {}) => decide(id, 'approved', decidedBy, undefined, opts);
export const deny = (id: string, decidedBy: string, reason?: string, opts: ApprovalOptions = {}) => decide(id, 'denied', decidedBy, reason, opts);

/**
 * PreToolUse: reserves an approved, unexpired, unused approval bound to exactly this actionHash.
 * Returns null when there is none (or it is already reserved by a live lease).
 */
export async function reserve(hash: string, ctx: { toolUseId?: string } = {}, opts: ApprovalOptions = {}): Promise<Reservation | null> {
  return mutate(opts, async (state, now, add) => {
    for (const i of state.values()) {
      const v = view(i, now);
      const a = v.approval;
      if (a.actionHash !== hash || a.usesLeft !== 1) continue;
      if (a.status !== 'approved' && a.status !== 'released') continue;
      const tok = crypto.randomBytes(16).toString('hex');
      const leaseUntil = new Date(now.getTime() + (opts.leaseMs ?? DEFAULT_LEASE_MS)).toISOString();
      await add({ v: 1, type: 'reserved', id: a.id, token: tok, actionHash: hash, leaseUntil, ...(ctx.toolUseId ? { toolUseId: ctx.toolUseId } : {}) });
      return state.get(a.id)!.lastRes ?? null;
    }
    return null;
  });
}

function byToken(state: Map<string, Internal>, tok: string): Internal | undefined {
  for (const i of state.values()) if (i.lastRes?.token === tok) return i;
  return undefined;
}

/** PostToolUse success: marks the reservation's approval consumed (single use). */
export async function consume(tok: string, opts: ApprovalOptions = {}): Promise<boolean> {
  return mutate(opts, async (state, _now, add) => {
    const i = byToken(state, tok);
    if (!i || i.approval.status !== 'reserved') return false;
    await add({ v: 1, type: 'consumed', id: i.approval.id, token: tok });
    return state.get(i.approval.id)!.approval.status === 'consumed';
  });
}

/** PostToolUse failure: gives the approval back (status 'released', reservable again). */
export async function release(tok: string, reason?: string, opts: ApprovalOptions = {}): Promise<boolean> {
  return mutate(opts, async (state, _now, add) => {
    const i = byToken(state, tok);
    if (!i || i.approval.status !== 'reserved') return false;
    await add({ v: 1, type: 'released', id: i.approval.id, token: tok, ...(reason ? { reason } : {}) });
    return state.get(i.approval.id)!.approval.status === 'released';
  });
}

/**
 * Finds the outstanding reservation for a finished tool call: by toolUseId when given, else the
 * single reservation for actionHash that carries no toolUseId. Includes lapsed-but-unsettled reservations so they can still settle.
 */
export async function findReservation(q: { toolUseId?: string; actionHash?: string }, opts: ApprovalOptions = {}): Promise<Reservation | null> {
  const state = await snapshot(opts);
  const hits: Reservation[] = [];
  for (const i of state.values()) {
    const r = i.lastRes;
    if (!r || i.approval.status !== 'reserved') continue;
    if (q.toolUseId && r.toolUseId === q.toolUseId) return r;
    // Fallback by hash only for reservations made without a toolUseId (another call's reservation is not ours).
    if (q.actionHash && r.actionHash === q.actionHash && !r.toolUseId) hits.push(r);
  }
  return hits.length === 1 ? hits[0]! : null;
}

export async function list(opts: ApprovalOptions & { status?: Approval['status'] } = {}): Promise<ApprovalState[]> {
  const state = await snapshot(opts);
  const now = nowOf(opts);
  return [...state.values()].map((i) => view(i, now)).filter((s) => !opts.status || s.approval.status === opts.status);
}

export async function get(id: string, opts: ApprovalOptions = {}): Promise<ApprovalState | null> {
  const i = (await snapshot(opts)).get(id);
  return i ? view(i, nowOf(opts)) : null;
}

/** Verifies the log against the recorded head without throwing. */
export async function verifyLog(opts: ApprovalOptions = {}): Promise<{ ok: true; count: number } | { ok: false; error: string }> {
  try {
    const s = await snapshot(opts);
    return { ok: true, count: s.size };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
