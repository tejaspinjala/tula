import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { write, read, readOptional, update, sweepTemp, StoreError, __setFaultInjector, __internal } from '../../../engine/lib/store.ts';
import { lockPathFor } from '../../../engine/lib/lock.ts';
import { fleetPath } from '../../../engine/lib/paths.ts';
import { counterSchema } from './fixtures/schemas.ts';
import { tempHome, runWorkers, workerPath } from './helpers.ts';

let h: ReturnType<typeof tempHome>;
beforeEach(() => { h = tempHome(); });
afterEach(() => { __setFaultInjector(null); h.cleanup(); });

const temps = (dir: string) => fs.readdirSync(dir).filter((n) => __internal.TEMP_RE.test(n));

describe('store', () => {
  test('write then read round-trips the parsed (validated) value', async () => {
    const f = fleetPath('state', 'c.json');
    const v = await write(f, { count: 3, extra: 'dropped' }, counterSchema);
    expect(v).toEqual({ count: 3 });
    expect(JSON.parse(fs.readFileSync(f, 'utf8'))).toEqual({ count: 3 });
    expect(await read(f, counterSchema)).toEqual({ count: 3 });
    expect(temps(path.dirname(f))).toEqual([]);
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
  });

  test('validation failure writes nothing (no file, no temp, no lock)', async () => {
    const f = fleetPath('state', 'c.json');
    const err = await write(f, { count: -1 }, counterSchema).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(StoreError);
    expect((err as StoreError).code).toBe('validation');
    expect(fs.existsSync(f)).toBe(false);
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
    await write(f, { count: 1 }, counterSchema);
    await expect(write(f, { count: 'x' }, counterSchema)).rejects.toThrow(StoreError);
    expect(await read(f, counterSchema)).toEqual({ count: 1 });
    expect(temps(path.dirname(f))).toEqual([]);
  });

  test('read: validation failure, bad JSON and missing file each throw a coded StoreError', async () => {
    const f = fleetPath('c.json');
    fs.writeFileSync(f, JSON.stringify({ count: 'nope' }));
    await expect(read(f, counterSchema)).rejects.toMatchObject({ code: 'validation' });
    fs.writeFileSync(f, '{"count": 1');
    await expect(read(f, counterSchema)).rejects.toMatchObject({ code: 'bad_json' });
    await expect(read(fleetPath('missing.json'), counterSchema)).rejects.toMatchObject({ code: 'not_found' });
    expect(await readOptional(fleetPath('missing.json'), counterSchema)).toBeUndefined();
  });

  test('rejects relative and reserved paths', async () => {
    await expect(write('rel.json', { count: 1 }, counterSchema)).rejects.toMatchObject({ code: 'invalid_path' });
    await expect(write(fleetPath('x.lock'), { count: 1 }, counterSchema)).rejects.toMatchObject({ code: 'invalid_path' });
  });

  test('update: validates fn result and the current file; a bad current file blocks the update', async () => {
    const f = fleetPath('c.json');
    expect(await update(f, counterSchema, (c) => ({ count: (c?.count ?? 0) + 5 }))).toEqual({ count: 5 });
    await expect(update(f, counterSchema, () => ({ count: -3 }))).rejects.toMatchObject({ code: 'validation' });
    expect(await read(f, counterSchema)).toEqual({ count: 5 });
    fs.writeFileSync(f, '{"count":"bad"}');
    let called = false;
    await expect(update(f, counterSchema, () => { called = true; return { count: 1 }; })).rejects.toMatchObject({ code: 'validation' });
    expect(called).toBe(false);
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
  });

  test('50 concurrent writer processes lose no updates', async () => {
    const f = fleetPath('state', 'counter.json');
    fs.mkdirSync(fleetPath('sync'), { recursive: true });
    const go = fleetPath('sync', 'go');
    const procs = 50;
    const each = 4;
    const res = await runWorkers(procs, () => ['update', f, String(each), go], go);
    for (const r of res) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect(await read(f, counterSchema)).toEqual({ count: procs * each });
    expect(temps(path.dirname(f))).toEqual([]);
    expect(fs.existsSync(lockPathFor(f))).toBe(false);
  }, 180_000);

  for (const point of ['after_temp_write', 'before_rename'] as const) {
    test(`process crash at ${point} leaves the old file intact; temp is swept; stale lock is recovered`, async () => {
      const f = fleetPath('state', 'c.json');
      await write(f, { count: 7 }, counterSchema);
      const p = Bun.spawn([process.execPath, workerPath, 'crash', f, point], { stdout: 'ignore', stderr: 'pipe' });
      expect(await p.exited).toBe(137);
      expect(await read(f, counterSchema)).toEqual({ count: 7 }); // old content, still valid
      const left = temps(path.dirname(f));
      expect(left.length).toBe(1); // the crashed writer's temp (holding count 999) is still there
      expect(JSON.parse(fs.readFileSync(path.join(path.dirname(f), left[0]), 'utf8'))).toEqual({ count: 999 });
      expect(fs.existsSync(lockPathFor(f))).toBe(true); // crashed holder never released
      expect(sweepTemp(path.dirname(f))).toEqual([path.join(path.dirname(f), left[0])]);
      expect(temps(path.dirname(f))).toEqual([]);
      expect(await update(f, counterSchema, (c) => ({ count: (c?.count ?? 0) + 1 }), { timeoutMs: 2_000 })).toEqual({ count: 8 });
      expect(fs.existsSync(lockPathFor(f))).toBe(false);
    }, 30_000);
  }

  test('in-process fault (throw) at each point: old file intact, temp removed, lock released', async () => {
    const f = fleetPath('c.json');
    await write(f, { count: 1 }, counterSchema);
    for (const point of ['after_temp_write', 'before_rename'] as const) {
      __setFaultInjector((pt) => { if (pt === point) throw new Error(`fault ${pt}`); });
      await expect(write(f, { count: 2 }, counterSchema)).rejects.toThrow(`fault ${point}`);
      expect(await read(f, counterSchema)).toEqual({ count: 1 });
      expect(temps(h.dir)).toEqual([]);
      expect(fs.existsSync(lockPathFor(f))).toBe(false);
    }
  });

  test('sweepTemp removes only abandoned temp files', async () => {
    const dir = fleetPath('d');
    fs.mkdirSync(dir);
    const own = path.join(dir, `.a.json.tmp-${process.pid}-0123456789abcdef`);
    const oldOwn = path.join(dir, `.b.json.tmp-${process.pid}-0123456789abcdee`);
    const dead = path.join(dir, `.c.json.tmp-999999999-0123456789abcdef`);
    const other = path.join(dir, 'c.json');
    const lookalike = path.join(dir, '.c.json.tmp-12-short');
    for (const f of [own, oldOwn, dead, other, lookalike]) fs.writeFileSync(f, '{}');
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(oldOwn, old, old);
    expect(sweepTemp(dir).sort()).toEqual([oldOwn, dead].sort());
    expect(fs.existsSync(own) && fs.existsSync(other) && fs.existsSync(lookalike)).toBe(true);
    expect(sweepTemp(fleetPath('nope'))).toEqual([]);
  });
});
