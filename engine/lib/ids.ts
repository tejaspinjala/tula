// Sortable unique ids: `<prefix>_<10 chars time><16 chars random>` in Crockford base32.
// The time part is 48-bit milliseconds since the epoch, so ids sort by creation time as plain strings.
// Within one process, ids created in the same millisecond stay strictly increasing (the random part is
// incremented instead of re-drawn). Across processes, uniqueness comes from 80 bits of crypto randomness.
import crypto from 'node:crypto';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'; // Crockford base32, no I L O U
const TIME_LEN = 10;
const RAND_LEN = 16;
const PREFIX_RE = /^[a-z][a-z0-9]{0,15}$/;
const BODY_RE = new RegExp(`^[${ALPHABET}]{${TIME_LEN + RAND_LEN}}$`);
const MAX_TIME = 2 ** 48 - 1;

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  let t = ms;
  for (let i = 0; i < TIME_LEN; i++) {
    out = ALPHABET[t % 32] + out;
    t = Math.floor(t / 32);
  }
  return out;
}

function randomDigits(): number[] {
  const bytes = crypto.randomBytes(RAND_LEN);
  return Array.from(bytes, (b) => b % 32); // 256 % 32 === 0, so no modulo bias
}

/** Adds 1 to a base32 digit array in place. Returns false on overflow. */
function increment(d: number[]): boolean {
  for (let i = d.length - 1; i >= 0; i--) {
    if (d[i] < 31) {
      d[i]++;
      return true;
    }
    d[i] = 0;
  }
  return false;
}

export function assertPrefix(prefix: string): void {
  if (!PREFIX_RE.test(prefix)) throw new Error(`invalid id prefix ${JSON.stringify(prefix)}: must match ${PREFIX_RE}`);
}

/** Returns a new id like `task_01JAB...`. `now` is injectable for tests. */
export function newId(prefix: string, now: number = Date.now()): string {
  assertPrefix(prefix);
  if (!Number.isInteger(now) || now < 0 || now > MAX_TIME) throw new Error(`time out of range: ${now}`);
  let rand: number[];
  if (now <= lastTime) {
    // Same (or earlier, clock went back) millisecond: keep the last time and bump the random part.
    rand = lastRand.slice();
    if (!increment(rand)) throw new Error('id random space exhausted for this millisecond');
    now = lastTime;
  } else {
    rand = randomDigits();
  }
  lastTime = now;
  lastRand = rand;
  return `${prefix}_${encodeTime(now)}${rand.map((d) => ALPHABET[d]).join('')}`;
}

/** True when `id` is well formed, and (if given) has exactly this prefix. */
export function isId(id: unknown, prefix?: string): id is string {
  if (typeof id !== 'string') return false;
  const i = id.indexOf('_');
  if (i < 0) return false;
  const pre = id.slice(0, i);
  const body = id.slice(i + 1);
  if (!PREFIX_RE.test(pre) || !BODY_RE.test(body)) return false;
  if (prefix !== undefined && pre !== prefix) return false;
  return decodeTime(body.slice(0, TIME_LEN)) <= MAX_TIME;
}

export function assertId(id: unknown, prefix?: string): asserts id is string {
  if (!isId(id, prefix)) throw new Error(`invalid id ${JSON.stringify(id)}${prefix ? ` (expected prefix ${prefix})` : ''}`);
}

function decodeTime(s: string): number {
  let t = 0;
  for (const ch of s) t = t * 32 + ALPHABET.indexOf(ch);
  return t;
}

/** Creation time (ms since epoch) encoded in a valid id. */
export function idTime(id: string): number {
  assertId(id);
  return decodeTime(id.slice(id.indexOf('_') + 1, id.indexOf('_') + 1 + TIME_LEN));
}
