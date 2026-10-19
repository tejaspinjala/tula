import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withLock, acquire, release, lockPathFor, readLock, LockTimeoutError, LockLostError } from '../../../engine/lib/lock.ts';
import { read } from '../../../engine/lib/store.ts';
import { counterSchema } from './fixtures/schemas.ts';
import { tempHome, runWorkers, deadPid } from './helpers.ts';

let h: ReturnType<typeof tempHome>;
beforeEach(() => { h = tempHome(); });
afterEach(() => h.cleanup());

const plant = (file: string, info: Record<string, unknown>) => fs.writeFileSync(lockPathFor(file), JSON.stringify(info));

describe('lock', () => {
  test('mutual exclusion across 8 real processes doing store.update', async () => {
    const file = path.join(h.dir, 'counter.json');
    fs.mkdirSync(path.join(h.dir, 'sync'));
    const go = path.join(h.dir, 'sync', 'go');
    const procs = 8;
    const each = 25;
    const res = await runWorkers(procs, () => ['update', file, String(each), go], go);
    for (const r of res) expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' });
    expect((await read(file, counterSchema)).count).toBe(procs * each);
    expect(fs.existsSync(lockPathFor(file))).toBe(false);
  }, 120_000);

  test('mutual exclusion within one process (overlapping async holders)', async () => {
    const file = path.join(h.dir, 'x');
    let inside = 0;
    let maxInside = 0;
    await Promise.all(Array.from({ length: 20 }, () => withLock(file, async () => {
      inside++;
      maxInside = Math.max(maxInside, inside);
      await new Promise((r) => setTimeout(r, 2));
      inside--;
    })));
    expect(maxInside).toBe(1);
  });

  test('takes over a stale lock whose pid is dead on this host', async () => {
    const file = path.join(h.dir, 'f');
    plant(file, { pid: await deadPid(), host: os.hostname(), ts: Date.now(), token: 'dead' });
    const t0 = Date.now();
    expect(await withLock(file, () => 'ran', { timeoutMs: 2_000, staleMs: 60_000 })).toBe('ran');
    expect(Date.now() - t0).toBeLessThan(1_500);
    expect(fs.existsSync(lockPathFor(file))).toBe(false);
  });

  test('takes over a lock older than staleMs even if its pid is alive', async () => {
    const file = path.join(h.dir, 'f');
    plant(file, { pid: process.pid, host: os.hostname(), ts: Date.now() - 10_000, token: 'old' });
    expect(await withLock(file, () => 1, { timeoutMs: 2_000, staleMs: 1_000 })).toBe(1);
  });

  test('does not take over a fresh lock from another host (pid cannot be checked)', async () => {
    const file = path.join(h.dir, 'f');
    plant(file, { pid: 1, host: 'some-other-host', ts: Date.now(), token: 'remote' });
    await expect(withLock(file, () => 1, { timeoutMs: 150 })).rejects.toBeInstanceOf(LockTimeoutError);
    expect(readLock(lockPathFor(file))?.info?.token).toBe('remote');
  });

  test('times out with LockTimeoutError naming the holder', async () => {
    const file = path.join(h.dir, 'f');
    const held = await acquire(file);
    const t0 = Date.now();
    const err = await withLock(file, () => 1, { timeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockTimeoutError);
    expect((err as LockTimeoutError).holder?.pid).toBe(process.pid);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(190);
    expect(release(held)).toBe(true);
  });

  test('an unparseable lockfile counts as stale only once its mtime is older than staleMs', async () => {
    const file = path.join(h.dir, 'f');
    fs.writeFileSync(lockPathFor(file), ''); // like a holder between open(O_EXCL) and write
    await expect(withLock(file, () => 1, { timeoutMs: 100, staleMs: 5_000 })).rejects.toBeInstanceOf(LockTimeoutError);
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPathFor(file), old, old);
    expect(await withLock(file, () => 2, { timeoutMs: 1_000, staleMs: 5_000 })).toBe(2);
  });

  test('release is token-safe: never deletes a lock it does not own', async () => {
    const file = path.join(h.dir, 'f');
    const a = await acquire(file);
    expect(a.held()).toBe(true);
    plant(file, { pid: process.pid, host: os.hostname(), ts: Date.now(), token: 'someone-else' });
    expect(a.held()).toBe(false);
    expect(release(a)).toBe(false);
    expect(readLock(lockPathFor(file))?.info?.token).toBe('someone-else');
  });

  test('withLock reports LockLostError if the lock was taken over during fn, and is released after throws', async () => {
    const file = path.join(h.dir, 'f');
    const err = await withLock(file, () => {
      plant(file, { pid: process.pid, host: os.hostname(), ts: Date.now(), token: 'thief' });
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LockLostError);
    fs.rmSync(lockPathFor(file));
    await expect(withLock(file, () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(fs.existsSync(lockPathFor(file))).toBe(false);
  });
});
