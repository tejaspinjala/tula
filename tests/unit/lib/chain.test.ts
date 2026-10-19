import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import { append, verify, head, canonicalJson, entryHash, GENESIS, ChainError, type ChainEntry } from '../../../engine/lib/chain.ts';
import { lockPathFor } from '../../../engine/lib/lock.ts';
import { fleetPath } from '../../../engine/lib/paths.ts';
import { tempHome, runWorkers } from './helpers.ts';

let h: ReturnType<typeof tempHome>;
beforeEach(() => { h = tempHome(); });
afterEach(() => h.cleanup());

const lines = (f: string) => fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
const setLines = (f: string, ls: string[]) => fs.writeFileSync(f, ls.join('\n') + '\n');
const parse = (l: string) => JSON.parse(l) as ChainEntry;

async function chainOf(n: number): Promise<string> {
  const f = fleetPath('audit', 'audit.jsonl');
  for (let i = 1; i <= n; i++) await append(f, { action: 'test', i });
  return f;
}

describe('canonicalJson', () => {
  test('sorts keys recursively and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  });
  test('rejects values that would not round-trip', () => {
    for (const bad of [undefined, NaN, Infinity, () => 1, 1n, new Date(), { a: undefined }, [undefined]]) {
      expect(() => canonicalJson(bad)).toThrow(TypeError);
    }
  });
});

describe('chain', () => {
  test('append builds a linked chain; verify ok; head reads the tail', async () => {
    const f = await chainOf(5);
    const es = lines(f).map(parse);
    expect(es.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(es[0].prevHash).toBe(GENESIS);
    for (let i = 1; i < es.length; i++) expect(es[i].prevHash).toBe(es[i - 1].hash);
    for (const e of es) expect(e.hash).toBe(entryHash(e));
    expect(verify(f)).toEqual({ ok: true, count: 5, head: { seq: 5, hash: es[4].hash } });
    expect(head(f)).toEqual({ seq: 5, hash: es[4].hash });
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
  });

  test('verify of an empty or missing file is ok with count 0', () => {
    const f = fleetPath('empty.jsonl');
    expect(verify(f)).toEqual({ ok: true, count: 0, head: null });
    fs.writeFileSync(f, '');
    expect(verify(f)).toEqual({ ok: true, count: 0, head: null });
    expect(head(f)).toBeNull();
  });

  test('append reads only the tail (works on a long chain with a big payload line)', async () => {
    const f = fleetPath('big.jsonl');
    await append(f, { blob: 'x'.repeat(50_000) });
    const e = await append(f, { blob: 'y'.repeat(20_000) });
    expect(e.seq).toBe(2);
    expect(verify(f)).toMatchObject({ ok: true, count: 2 });
  });

  test('20 concurrent appender processes produce a gap-free, verifying chain', async () => {
    const f = fleetPath('audit', 'audit.jsonl');
    fs.mkdirSync(fleetPath('sync'), { recursive: true });
    const go = fleetPath('sync', 'go');
    const procs = 20;
    const each = 10;
    const res = await runWorkers(procs, (i) => ['append', f, String(each), go, `w${i}`], go);
    for (const r of res) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    const v = verify(f);
    expect(v).toMatchObject({ ok: true, count: procs * each });
    const es = lines(f).map(parse);
    expect(es.map((e) => e.seq)).toEqual(Array.from({ length: procs * each }, (_, i) => i + 1));
    const seen = new Set(es.map((e) => canonicalJson(e.payload)));
    expect(seen.size).toBe(procs * each); // every (worker, i) exactly once
  }, 180_000);

  test('tampered payload is detected at its seq', async () => {
    const f = await chainOf(6);
    const ls = lines(f);
    const e = parse(ls[3]);
    ls[3] = canonicalJson({ ...e, payload: { action: 'evil', i: 4 } });
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 4, reason: 'hash_mismatch' });
  });

  test('tampered payload with a recomputed hash is detected at the next seq', async () => {
    const f = await chainOf(6);
    const ls = lines(f);
    const e = parse(ls[3]);
    const forged = { ...e, payload: { action: 'evil', i: 4 } };
    ls[3] = canonicalJson({ ...forged, hash: entryHash(forged) });
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 5, reason: 'prev_hash_mismatch' });
  });

  test('deleting a middle line is detected at the missing seq', async () => {
    const f = await chainOf(6);
    const ls = lines(f);
    ls.splice(2, 1);
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 3, reason: 'seq_mismatch' });
  });

  test('swapping two lines is detected at the first swapped position', async () => {
    const f = await chainOf(6);
    const ls = lines(f);
    [ls[1], ls[4]] = [ls[4], ls[1]];
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 2, reason: 'seq_mismatch' });
  });

  test('cutting bytes out of the middle is detected at the damaged line', async () => {
    const f = await chainOf(6);
    const text = fs.readFileSync(f, 'utf8');
    const start = text.indexOf('\n', text.length / 2) - 20;
    fs.writeFileSync(f, text.slice(0, start) + text.slice(start + 60));
    const v = verify(f);
    expect(v.ok).toBe(false);
    if (!v.ok) {
      // The merged line may be bad JSON, or (duplicate keys) valid JSON with the wrong seq/hash.
      expect(['bad_json', 'bad_shape', 'seq_mismatch', 'hash_mismatch', 'prev_hash_mismatch']).toContain(v.reason);
      expect(v.atSeq).toBe(text.slice(0, start).split('\n').length);
    }
  });

  test('editing prevHash is detected at its seq', async () => {
    const f = await chainOf(5);
    const ls = lines(f);
    ls[2] = canonicalJson({ ...parse(ls[2]), prevHash: 'f'.repeat(64) });
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 3, reason: 'prev_hash_mismatch' });
  });

  test('extra or malformed fields are bad_shape', async () => {
    const f = await chainOf(3);
    const ls = lines(f);
    ls[1] = JSON.stringify({ ...parse(ls[1]), extra: 1 });
    setLines(f, ls);
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 2, reason: 'bad_shape' });
  });

  test('truncation at a line boundary is caught when a recorded head is given', async () => {
    const f = await chainOf(5);
    const recorded = head(f);
    expect(recorded).not.toBeNull();
    setLines(f, lines(f).slice(0, 3));
    expect(verify(f)).toMatchObject({ ok: true, count: 3 }); // undetectable without an anchor
    expect(verify(f, { expect: recorded! })).toMatchObject({ ok: false, atSeq: 4, reason: 'truncated' });
  });

  test('torn last line: verify reports it, append refuses, append with repair cuts only the torn bytes', async () => {
    const f = await chainOf(3);
    const good = fs.readFileSync(f, 'utf8');
    fs.appendFileSync(f, '{"hash":"abc","payl');
    expect(verify(f)).toMatchObject({ ok: false, atSeq: 4, reason: 'torn_tail' });
    const err = await append(f, { x: 1 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChainError);
    expect((err as ChainError).code).toBe('torn_tail');
    expect(() => head(f)).toThrow(ChainError);
    expect(fs.readFileSync(f, 'utf8')).toBe(good + '{"hash":"abc","payl'); // untouched without repair
    const e = await append(f, { x: 1 }, { repair: true });
    expect(e.seq).toBe(4);
    expect(verify(f)).toMatchObject({ ok: true, count: 4 });
    expect(fs.readFileSync(f, 'utf8').startsWith(good)).toBe(true);
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
  });

  test('a corrupt (complete) last line blocks append even with repair', async () => {
    const f = await chainOf(2);
    const ls = lines(f);
    ls[1] = canonicalJson({ ...parse(ls[1]), payload: { tampered: true } });
    setLines(f, ls);
    await expect(append(f, { x: 1 }, { repair: true })).rejects.toMatchObject({ code: 'corrupt_tail' });
    expect(lines(f).length).toBe(2);
  });

  test('append rejects non-JSON payloads before touching the file', async () => {
    const f = fleetPath('a.jsonl');
    const bad = { when: new Date() } as unknown as { when: string };
    await expect(append(f, bad)).rejects.toThrow(TypeError);
    expect(fs.existsSync(f)).toBe(false);
  });
});
