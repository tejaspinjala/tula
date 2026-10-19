// Append-only, hash-chained JSONL. Each line is canonical JSON of
//   { seq, ts, prevHash, payload, hash }   with   hash = sha256(canonical({ seq, ts, prevHash, payload }))
// seq starts at 1 and is gap-free; the first prevHash is GENESIS (64 zeros).
// append() runs under the per-file lock and reads only the file's tail to find the last entry.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLock, type LockOptions } from './lock.ts';
import { fsyncDir } from './store.ts';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [k: string]: JsonValue };

export interface ChainEntry<P extends JsonValue = JsonValue> {
  seq: number;
  ts: string;
  prevHash: string;
  payload: P;
  hash: string;
}

export interface ChainHead {
  seq: number;
  hash: string;
}

export type VerifyReason =
  | 'bad_json'
  | 'bad_shape'
  | 'seq_mismatch'
  | 'prev_hash_mismatch'
  | 'hash_mismatch'
  | 'torn_tail'
  | 'truncated'
  | 'head_mismatch';

export type VerifyResult =
  | { ok: true; count: number; head: ChainHead | null }
  | { ok: false; atSeq: number; reason: VerifyReason; detail: string };

export type ChainErrorCode = 'torn_tail' | 'corrupt_tail' | 'not_json';

export class ChainError extends Error {
  constructor(public readonly code: ChainErrorCode, public readonly file: string, message: string) {
    super(`${code}: ${file}: ${message}`);
    this.name = 'ChainError';
  }
}

export const GENESIS = '0'.repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;
const NL = 0x0a;

/** JSON with object keys sorted (recursively). Throws on anything that would not round-trip through JSON. */
export function canonicalJson(value: unknown): string {
  return canon(value, '$');
}

function canon(v: unknown, at: string): string {
  if (v === null) return 'null';
  switch (typeof v) {
    case 'boolean':
      return v ? 'true' : 'false';
    case 'string':
      return JSON.stringify(v);
    case 'number':
      if (!Number.isFinite(v)) throw new TypeError(`non-finite number at ${at}`);
      return JSON.stringify(v);
    case 'object': {
      if (Array.isArray(v)) return '[' + v.map((x, i) => canon(x, `${at}[${i}]`)).join(',') + ']';
      const proto: unknown = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) throw new TypeError(`non-plain object at ${at}`);
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).sort();
      return '{' + keys.map((k) => `${JSON.stringify(k)}:${canon(o[k], `${at}.${k}`)}`).join(',') + '}';
    }
    default:
      throw new TypeError(`${typeof v} is not JSON at ${at}`);
  }
}

export function entryHash(e: { seq: number; ts: string; prevHash: string; payload: unknown }): string {
  return crypto.createHash('sha256').update(canonicalJson({ seq: e.seq, ts: e.ts, prevHash: e.prevHash, payload: e.payload })).digest('hex');
}

function shapeOf(o: unknown): ChainEntry | string {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return 'line is not an object';
  const r = o as Record<string, unknown>;
  const keys = Object.keys(r).sort().join(',');
  if (keys !== 'hash,payload,prevHash,seq,ts') return `unexpected keys: ${keys}`;
  if (typeof r.seq !== 'number' || !Number.isInteger(r.seq) || r.seq < 1) return 'seq must be a positive integer';
  if (typeof r.ts !== 'string') return 'ts must be a string';
  if (typeof r.prevHash !== 'string' || !HEX64.test(r.prevHash)) return 'prevHash must be 64 hex chars';
  if (typeof r.hash !== 'string' || !HEX64.test(r.hash)) return 'hash must be 64 hex chars';
  return { seq: r.seq, ts: r.ts, prevHash: r.prevHash, payload: r.payload as JsonValue, hash: r.hash };
}

/** Reads the last line of a newline-terminated file of `size` bytes, scanning backwards in chunks. */
function readLastLine(fd: number, size: number): string {
  const end = size - 1; // index of the final '\n'
  const chunks: Buffer[] = [];
  let pos = end;
  const CHUNK = 4096;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const buf = Buffer.alloc(pos - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const i = buf.lastIndexOf(NL);
    if (i >= 0) {
      chunks.unshift(buf.subarray(i + 1));
      return Buffer.concat(chunks).toString('utf8');
    }
    chunks.unshift(buf);
    pos = start;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Offset just past the last '\n' in the file (0 if none). */
function lastNewlineEnd(fd: number, size: number): number {
  let pos = size;
  const CHUNK = 4096;
  while (pos > 0) {
    const start = Math.max(0, pos - CHUNK);
    const buf = Buffer.alloc(pos - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const i = buf.lastIndexOf(NL);
    if (i >= 0) return start + i + 1;
    pos = start;
  }
  return 0;
}

/**
 * Last entry of the chain, read from the tail only (the tail line's own hash is checked).
 * Returns null for a missing/empty file. Throws ChainError on a torn or corrupt tail.
 */
export function head(file: string): ChainHead | null {
  let fd: number;
  try {
    fd = fs.openSync(file, 'r');
  } catch (e) {
    if (typeof e === 'object' && e !== null && 'code' in e && (e as { code: unknown }).code === 'ENOENT') return null;
    throw e;
  }
  try {
    return tailOf(file, fd);
  } finally {
    fs.closeSync(fd);
  }
}

function tailOf(file: string, fd: number): ChainHead | null {
  const size = fs.fstatSync(fd).size;
  if (size === 0) return null;
  const last = Buffer.alloc(1);
  fs.readSync(fd, last, 0, 1, size - 1);
  if (last[0] !== NL) throw new ChainError('torn_tail', file, 'last line is incomplete (no trailing newline)');
  const line = readLastLine(fd, size);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new ChainError('corrupt_tail', file, 'last line is not valid JSON');
  }
  const e = shapeOf(parsed);
  if (typeof e === 'string') throw new ChainError('corrupt_tail', file, e);
  if (entryHash(e) !== e.hash) throw new ChainError('corrupt_tail', file, `hash mismatch on last line (seq ${e.seq})`);
  return { seq: e.seq, hash: e.hash };
}

export interface AppendOptions extends LockOptions {
  /** If the last line is incomplete (no trailing newline), cut it off before appending. Default false. */
  repair?: boolean;
  /** Injectable clock for tests. */
  now?: () => Date;
}

/**
 * Appends one entry under the file lock and fsyncs it. Returns the written entry.
 * A torn final line makes it throw ChainError('torn_tail') unless `repair` is set, in which case
 * only the bytes after the last newline are truncated. A tail line that fails its own hash check
 * always throws ('corrupt_tail'): appending would extend a broken chain.
 */
export async function append<P extends JsonValue>(file: string, payload: P, opts: AppendOptions = {}): Promise<ChainEntry<P>> {
  if (!path.isAbsolute(file)) throw new Error(`chain path must be absolute: ${file}`);
  canonicalJson(payload); // reject non-JSON payloads before taking the lock
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  return withLock(file, () => {
    const created = !fs.existsSync(file);
    const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND, 0o600);
    try {
      let tail: ChainHead | null;
      try {
        tail = tailOf(file, fd);
      } catch (err) {
        if (!(err instanceof ChainError && err.code === 'torn_tail' && opts.repair)) throw err;
        const size = fs.fstatSync(fd).size;
        fs.ftruncateSync(fd, lastNewlineEnd(fd, size));
        fs.fsyncSync(fd);
        tail = tailOf(file, fd);
      }
      const seq = (tail?.seq ?? 0) + 1;
      const prevHash = tail?.hash ?? GENESIS;
      const ts = (opts.now?.() ?? new Date()).toISOString();
      const entry: ChainEntry<P> = { seq, ts, prevHash, payload, hash: '' };
      entry.hash = entryHash(entry);
      fs.writeSync(fd, canonicalJson(entry) + '\n');
      fs.fsyncSync(fd);
      return entry;
    } finally {
      fs.closeSync(fd);
      if (created) fsyncDir(dir);
    }
  }, opts);
}

/** Calls onLine(text, index) for each '\n'-terminated line; returns the unterminated remainder. */
function forEachLine(file: string, onLine: (line: string, i: number) => boolean): { remainder: string; lines: number } {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(64 * 1024);
    let carry: Buffer = Buffer.alloc(0);
    let i = 0;
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      let data = Buffer.concat([carry, buf.subarray(0, n)]);
      let nl: number;
      while ((nl = data.indexOf(NL)) >= 0) {
        if (!onLine(data.subarray(0, nl).toString('utf8'), i++)) return { remainder: '', lines: i };
        data = data.subarray(nl + 1);
      }
      carry = Buffer.from(data);
    }
    return { remainder: carry.toString('utf8'), lines: i };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Walks the whole chain. ok:false names the first bad seq (the seq the line at that position
 * should have had) and why. A missing or empty file verifies as { ok: true, count: 0 }.
 * Truncation exactly at a line boundary is only detectable with `expect` (a previously recorded head).
 */
export function verify(file: string, opts: { expect?: ChainHead } = {}): VerifyResult {
  if (!fs.existsSync(file)) return opts.expect ? { ok: false, atSeq: 1, reason: 'truncated', detail: 'file missing' } : { ok: true, count: 0, head: null };
  const st: { fail: VerifyResult | null; prev: ChainHead | null; anchorSeen: boolean } = { fail: null, prev: null, anchorSeen: false };
  const { remainder, lines } = forEachLine(file, (line, i) => {
    const expected = i + 1;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      st.fail = { ok: false, atSeq: expected, reason: 'bad_json', detail: `line ${expected} is not valid JSON` };
      return false;
    }
    const e = shapeOf(parsed);
    if (typeof e === 'string') {
      st.fail = { ok: false, atSeq: expected, reason: 'bad_shape', detail: e };
      return false;
    }
    if (e.seq !== expected) {
      st.fail = { ok: false, atSeq: expected, reason: 'seq_mismatch', detail: `expected seq ${expected}, found ${e.seq}` };
      return false;
    }
    const wantPrev = st.prev?.hash ?? GENESIS;
    if (e.prevHash !== wantPrev) {
      st.fail = { ok: false, atSeq: expected, reason: 'prev_hash_mismatch', detail: `prevHash does not match hash of seq ${expected - 1}` };
      return false;
    }
    if (entryHash(e) !== e.hash) {
      st.fail = { ok: false, atSeq: expected, reason: 'hash_mismatch', detail: `content hash differs from stored hash` };
      return false;
    }
    if (opts.expect && e.seq === opts.expect.seq) {
      if (e.hash !== opts.expect.hash) {
        st.fail = { ok: false, atSeq: expected, reason: 'head_mismatch', detail: 'entry differs from the recorded head' };
        return false;
      }
      st.anchorSeen = true;
    }
    st.prev = { seq: e.seq, hash: e.hash };
    return true;
  });
  if (st.fail) return st.fail;
  if (remainder.length > 0) return { ok: false, atSeq: lines + 1, reason: 'torn_tail', detail: 'last line is incomplete (no trailing newline)' };
  if (opts.expect && !st.anchorSeen) {
    return { ok: false, atSeq: lines + 1, reason: 'truncated', detail: `chain has ${lines} entries, recorded head is seq ${opts.expect.seq}` };
  }
  return { ok: true, count: lines, head: st.prev };
}
