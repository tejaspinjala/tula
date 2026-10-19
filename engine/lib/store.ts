// The one sanctioned write path for canonical JSON state.
// write: validate (schema.parse) -> JSON -> temp file in the same dir -> fsync -> rename -> fsync dir,
// all under the per-file lock. update: locked read-modify-write (the only sanctioned RMW).
// read: parse + validate, no lock needed (rename is atomic, so readers see old or new, never half).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { withLock, pidAlive, LockLostError, type LockOptions, type LockHandle } from './lock.ts';

/** Anything with a parse() that returns T or throws. Zod schemas satisfy this structurally. */
export interface Schema<T> {
  parse(input: unknown): T;
}

export type StoreErrorCode = 'not_found' | 'bad_json' | 'validation' | 'invalid_path';

export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, public readonly file: string, message: string, options?: { cause?: unknown }) {
    super(`${code}: ${file}: ${message}`, options);
    this.name = 'StoreError';
  }
}

export type FaultPoint = 'after_temp_write' | 'before_rename';
type FaultInjector = (point: FaultPoint, info: { file: string; temp: string }) => void;
let faultInjector: FaultInjector | null = null;

/** TESTS ONLY: called at named points inside write(). Throw or process.exit() to simulate a crash. */
export function __setFaultInjector(fn: FaultInjector | null): void {
  faultInjector = fn;
}

const errCode = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'code' in e ? String((e as { code: unknown }).code) : undefined;

// Temp names: `.<base>.tmp-<pid>-<hex>`; the pid lets sweepTemp tell abandoned temps from live ones.
const TEMP_RE = /^\..+\.tmp-(\d+)-[0-9a-f]{16}$/;
const tempNameFor = (file: string): string =>
  path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(8).toString('hex')}`);

function checkPath(file: string): void {
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0')) {
    throw new StoreError('invalid_path', String(file), 'store paths must be absolute (build them with resolveInside)');
  }
  if (TEMP_RE.test(path.basename(file)) || file.endsWith('.lock') || file.endsWith('.lock.break')) {
    throw new StoreError('invalid_path', file, 'reserved file name');
  }
}

/** fsync a directory so a rename/create in it is durable. Ignored where the platform refuses it. */
export function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch (e) {
    const c = errCode(e);
    if (c !== 'EISDIR' && c !== 'EINVAL' && c !== 'EPERM' && c !== 'EBADF') throw e;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validate<T>(file: string, schema: Schema<T>, value: unknown): T {
  try {
    return schema.parse(value);
  } catch (e) {
    throw new StoreError('validation', file, e instanceof Error ? e.message : String(e), { cause: e });
  }
}

function readParsed<T>(file: string, schema: Schema<T>): T | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (errCode(e) === 'ENOENT') return undefined;
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new StoreError('bad_json', file, e instanceof Error ? e.message : String(e), { cause: e });
  }
  return validate(file, schema, raw);
}

/** Atomic replace. Caller must hold the lock for `file`. */
function writeLocked<T>(file: string, value: T, h: LockHandle): void {
  const dir = path.dirname(file);
  const body = JSON.stringify(value, null, 2) + '\n';
  const temp = tempNameFor(file);
  let renamed = false;
  try {
    const fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    faultInjector?.('after_temp_write', { file, temp });
    if (!h.held()) throw new LockLostError(file); // never publish a write after losing the lock
    faultInjector?.('before_rename', { file, temp });
    fs.renameSync(temp, file);
    renamed = true;
    fsyncDir(dir);
  } finally {
    if (!renamed) fs.rmSync(temp, { force: true });
  }
}

/** Validates `data`, then atomically replaces `file` with the parsed value. Returns the parsed value. */
export async function write<T>(file: string, data: unknown, schema: Schema<T>, opts: LockOptions = {}): Promise<T> {
  checkPath(file);
  const value = validate(file, schema, data); // nothing touches disk if this throws
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, (h) => {
    writeLocked(file, value, h);
    return value;
  }, opts);
}

/** Reads and validates `file`. Throws StoreError('not_found') if missing. */
export async function read<T>(file: string, schema: Schema<T>): Promise<T> {
  checkPath(file);
  const v = readParsed(file, schema);
  if (v === undefined) throw new StoreError('not_found', file, 'file does not exist');
  return v;
}

/** Like read(), but returns undefined when the file does not exist. */
export async function readOptional<T>(file: string, schema: Schema<T>): Promise<T | undefined> {
  checkPath(file);
  return readParsed(file, schema);
}

/**
 * Locked read-modify-write: reads (validated; undefined if missing), calls fn, validates and writes
 * its result, returns the new value. The lock is held across all of it, so concurrent updates never
 * lose each other's changes. If the current file fails validation, fn is not called and it throws.
 */
export async function update<T>(
  file: string,
  schema: Schema<T>,
  fn: (current: T | undefined) => unknown | Promise<unknown>,
  opts: LockOptions = {},
): Promise<T> {
  checkPath(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return withLock(file, async (h) => {
    const cur = readParsed(file, schema);
    const next = validate(file, schema, await fn(cur));
    writeLocked(file, next, h);
    return next;
  }, opts);
}

/**
 * Removes temp files left in `dir` by crashed writers: those whose pid is dead on this host,
 * or older than olderThanMs (default 60s). Returns the removed paths. Never touches non-temp files.
 */
export function sweepTemp(dir: string, opts: { olderThanMs?: number } = {}): string[] {
  const olderThanMs = opts.olderThanMs ?? 60_000;
  const removed: string[] = [];
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    if (errCode(e) === 'ENOENT') return removed;
    throw e;
  }
  const now = Date.now();
  for (const name of names) {
    const m = TEMP_RE.exec(name);
    if (!m) continue;
    const full = path.join(dir, name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const pid = Number(m[1]);
    const dead = pid !== process.pid && !pidAlive(pid);
    if (dead || now - st.mtimeMs > olderThanMs) {
      fs.rmSync(full, { force: true });
      removed.push(full);
    }
  }
  return removed;
}

export const __internal = { TEMP_RE };
