// Cross-process per-file lock: `<file>.lock` created with O_CREAT|O_EXCL, holding
// { pid, host, ts, token } as JSON. Waiters retry with capped exponential backoff + jitter.
// A lock is stale when its pid is dead on this host, or it is older than staleMs.
// Stale locks are broken under a short-lived `<file>.lock.break` mutex so two waiters never
// both break and both acquire. Release deletes the lockfile only if it still holds our token.
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';

export interface LockInfo {
  pid: number;
  host: string;
  ts: number;
  token: string;
}

export interface LockOptions {
  /** Give up waiting after this long. Default 10_000 ms. */
  timeoutMs?: number;
  /** A lock older than this is considered abandoned. Default 30_000 ms. The holder must finish within it. */
  staleMs?: number;
}

export interface LockHandle {
  readonly file: string;
  readonly lockPath: string;
  readonly token: string;
  /** True while the lockfile on disk still carries our token. */
  held(): boolean;
}

export class LockTimeoutError extends Error {
  constructor(public readonly file: string, public readonly waitedMs: number, public readonly holder: LockInfo | null) {
    super(`timed out after ${waitedMs}ms waiting for lock on ${file}${holder ? ` (held by pid ${holder.pid}@${holder.host})` : ''}`);
    this.name = 'LockTimeoutError';
  }
}

export class LockLostError extends Error {
  constructor(public readonly file: string) {
    super(`lock on ${file} was lost while held (exceeded staleMs or removed externally)`);
    this.name = 'LockLostError';
  }
}

const HOST = os.hostname();
const BREAK_STALE_MS = 2_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

export const lockPathFor = (file: string): string => `${file}.lock`;

export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errCode(e) === 'EPERM'; // exists but owned by someone else
  }
}

function parseInfo(text: string): LockInfo | null {
  try {
    const o: unknown = JSON.parse(text);
    if (typeof o !== 'object' || o === null) return null;
    const r = o as Record<string, unknown>;
    if (typeof r.pid === 'number' && typeof r.host === 'string' && typeof r.ts === 'number' && typeof r.token === 'string') {
      return { pid: r.pid, host: r.host, ts: r.ts, token: r.token };
    }
  } catch { /* torn or empty lockfile */ }
  return null;
}

/** Reads a lockfile. `raw` is the exact text so callers can compare-before-delete. */
export function readLock(lockPath: string): { info: LockInfo | null; raw: string; mtimeMs: number } | null {
  try {
    const raw = fs.readFileSync(lockPath, 'utf8');
    const mtimeMs = fs.statSync(lockPath).mtimeMs;
    return { info: parseInfo(raw), raw, mtimeMs };
  } catch (e) {
    if (errCode(e) === 'ENOENT') return null;
    throw e;
  }
}

function isStale(cur: { info: LockInfo | null; mtimeMs: number }, staleMs: number, now: number): boolean {
  if (!cur.info) return now - cur.mtimeMs > staleMs; // unparseable: may be mid-write, so only age counts
  if (cur.info.host === HOST && !pidAlive(cur.info.pid)) return true;
  return now - cur.info.ts > staleMs;
}

function tryCreate(lockPath: string, info: LockInfo): boolean {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
  } catch (e) {
    if (errCode(e) === 'EEXIST') return false;
    throw e;
  }
  try {
    fs.writeSync(fd, JSON.stringify(info));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return true;
}

/** Breaks `lockPath` if it still holds exactly `raw` and is still stale. Serialised by a break mutex. */
function tryBreak(lockPath: string, raw: string, staleMs: number): void {
  const breakPath = `${lockPath}.break`;
  const me: LockInfo = { pid: process.pid, host: HOST, ts: Date.now(), token: crypto.randomBytes(16).toString('hex') };
  if (!tryCreate(breakPath, me)) {
    // Someone else is breaking. If their break mutex is itself abandoned, clear it for the next round.
    const b = readLock(breakPath);
    if (b && isStale(b, BREAK_STALE_MS, Date.now())) {
      const again = readLock(breakPath);
      if (again && again.raw === b.raw) fs.rmSync(breakPath, { force: true });
    }
    return;
  }
  try {
    const cur = readLock(lockPath);
    if (cur && cur.raw === raw && isStale(cur, staleMs, Date.now())) fs.rmSync(lockPath, { force: true });
  } finally {
    const b = readLock(breakPath);
    if (b?.info?.token === me.token) fs.rmSync(breakPath, { force: true });
  }
}

/** Acquires the lock for `file`, waiting up to timeoutMs. Prefer withLock(). */
export async function acquire(file: string, opts: LockOptions = {}): Promise<LockHandle> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const staleMs = opts.staleMs ?? 30_000;
  const lockPath = lockPathFor(file);
  const token = crypto.randomBytes(16).toString('hex');
  const start = Date.now();
  let delay = 1;
  for (;;) {
    if (tryCreate(lockPath, { pid: process.pid, host: HOST, ts: Date.now(), token })) {
      return {
        file,
        lockPath,
        token,
        held: () => readLock(lockPath)?.info?.token === token,
      };
    }
    const cur = readLock(lockPath);
    if (cur && isStale(cur, staleMs, Date.now())) {
      tryBreak(lockPath, cur.raw, staleMs);
      if (!fs.existsSync(lockPath)) continue; // broken: retry at once
      delay = 1; // someone else is breaking it: short sleep, then retry
    }
    const waited = Date.now() - start;
    if (waited >= timeoutMs) throw new LockTimeoutError(file, waited, cur?.info ?? null);
    await sleep(Math.min(delay + Math.random() * delay, Math.max(1, timeoutMs - waited)));
    delay = Math.min(delay * 2, 50);
  }
}

/** Deletes the lockfile only if it still carries this handle's token. Returns whether it did. */
export function release(h: LockHandle): boolean {
  const cur = readLock(h.lockPath);
  if (!cur || cur.info?.token !== h.token) return false;
  fs.rmSync(h.lockPath, { force: true });
  return true;
}

/**
 * Runs fn while holding the lock for `file`; the lock is released in finally.
 * Throws LockLostError (after fn) if our lock was taken over while fn ran.
 */
export async function withLock<T>(file: string, fn: (h: LockHandle) => T | Promise<T>, opts: LockOptions = {}): Promise<T> {
  const h = await acquire(file, opts);
  let ok = false;
  try {
    const r = await fn(h);
    ok = true;
    return r;
  } finally {
    const released = release(h);
    if (ok && !released) throw new LockLostError(file);
  }
}
