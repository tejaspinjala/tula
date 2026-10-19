import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newId, isId, assertId, idTime } from '../../../engine/lib/ids.ts';
import { fleetHome, fleetPath, resolveInside, PathError } from '../../../engine/lib/paths.ts';
import { tempHome } from './helpers.ts';

describe('ids', () => {
  test('format: prefix + 26 Crockford base32 chars', () => {
    const id = newId('task');
    expect(id).toMatch(/^task_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(isId(id)).toBe(true);
    expect(isId(id, 'task')).toBe(true);
    expect(isId(id, 'run')).toBe(false);
  });
  // Injected times are all later than Date.now(): an earlier time would be clamped to the last one (monotonic).
  test('sorts by creation time across milliseconds', () => {
    const a = newId('ev', 3_700_000_000_000);
    const b = newId('ev', 3_700_000_000_001);
    const c = newId('ev', 3_800_000_000_000);
    expect([c, a, b].sort()).toEqual([a, b, c]);
    expect(idTime(a)).toBe(3_700_000_000_000);
  });
  test('strictly increasing within one millisecond, and unique over 20k ids', () => {
    const ids = Array.from({ length: 20_000 }, () => newId('x', 3_900_000_000_000));
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i++) expect(ids[i] > ids[i - 1]).toBe(true);
  });
  test('a clock that goes backwards still yields increasing ids', () => {
    const a = newId('y', 4_000_000_000_000);
    const b = newId('y', 3_000_000_000_000);
    expect(b > a).toBe(true);
  });
  test('rejects bad prefixes and malformed ids', () => {
    expect(() => newId('Bad')).toThrow();
    expect(() => newId('')).toThrow();
    expect(() => newId('a_b')).toThrow();
    for (const bad of ['', 'task', 'task_', 'task_0123', 'task_' + 'I'.repeat(26), 'TASK_' + '0'.repeat(26), 42, null]) {
      expect(isId(bad)).toBe(false);
    }
    expect(() => assertId('nope')).toThrow();
  });
});

describe('paths', () => {
  let h: ReturnType<typeof tempHome>;
  beforeEach(() => { h = tempHome(); });
  afterEach(() => h.cleanup());

  test('fleetHome uses $FLEET_HOME, defaults to ~/.tula-fleet, requires absolute', () => {
    expect(fleetHome()).toBe(h.dir);
    const prev = process.env.FLEET_HOME;
    delete process.env.FLEET_HOME;
    expect(fleetHome()).toBe(path.join(os.homedir(), '.tula-fleet'));
    process.env.FLEET_HOME = 'relative/dir';
    expect(() => fleetHome()).toThrow(PathError);
    process.env.FLEET_HOME = prev;
  });

  test('normal nested paths resolve under the root', () => {
    expect(fleetPath('tasks', 'a.json')).toBe(path.join(h.dir, 'tasks', 'a.json'));
    expect(fleetPath('brain/facts/x.md')).toBe(path.join(h.dir, 'brain', 'facts', 'x.md'));
    fs.mkdirSync(path.join(h.dir, 'real'));
    fs.symlinkSync(path.join(h.dir, 'real'), path.join(h.dir, 'inner-link'));
    expect(fleetPath('inner-link', 'f.json')).toBe(path.join(h.dir, 'inner-link', 'f.json')); // symlink inside root is ok
  });

  test('rejects ../ traversal in any form', () => {
    for (const segs of [['..'], ['../x'], ['a', '..', 'b'], ['a/../../etc/passwd'], ['a/./b'], ['a//b'], ['']]) {
      expect(() => resolveInside(h.dir, ...segs)).toThrow(PathError);
    }
  });
  test('rejects absolute segments, backslashes and NUL bytes', () => {
    expect(() => resolveInside(h.dir, '/etc/passwd')).toThrow(PathError);
    expect(() => resolveInside(h.dir, 'a', '/b')).toThrow(PathError);
    expect(() => resolveInside(h.dir, 'C:\\x')).toThrow(PathError);
    expect(() => resolveInside(h.dir, 'a\\..\\b')).toThrow(PathError);
    expect(() => resolveInside(h.dir, 'a\0b')).toThrow(PathError);
    expect(() => resolveInside('relative', 'a')).toThrow(PathError);
    expect(() => resolveInside(h.dir)).toThrow(PathError);
  });
  test('rejects symlink escapes (dir link, file link, dangling link)', () => {
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tula-outside-')));
    try {
      fs.symlinkSync(outside, path.join(h.dir, 'escape'));
      expect(() => resolveInside(h.dir, 'escape', 'secret.json')).toThrow(/escapes root/);
      expect(() => resolveInside(h.dir, 'escape')).toThrow(/escapes root/);
      fs.writeFileSync(path.join(outside, 'f'), 'x');
      fs.mkdirSync(path.join(h.dir, 'd'));
      fs.symlinkSync(path.join(outside, 'f'), path.join(h.dir, 'd', 'file-link'));
      expect(() => resolveInside(h.dir, 'd/file-link')).toThrow(/escapes root/);
      fs.symlinkSync(path.join(outside, 'missing'), path.join(h.dir, 'dangling'));
      expect(() => resolveInside(h.dir, 'dangling', 'x')).toThrow(/dangling/);
      // a link inside the root that hops out through another link
      fs.symlinkSync(path.join(h.dir, 'escape'), path.join(h.dir, 'hop'));
      expect(() => resolveInside(h.dir, 'hop', 'x')).toThrow(/escapes root/);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });
});
