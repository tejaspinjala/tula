import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { ConfigRegistry, createDefaultRegistry } from '../../../engine/home/registry.ts';
import { KIND_TABLE } from '../../../engine/home/kinds.ts';
import { COMPANY, DEPT, initedHome, writeJson } from './util.ts';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const mk = () => {
  const t = initedHome();
  cleanups.push(t.cleanup);
  return t.home;
};

test('valid config loads', async () => {
  const home = mk();
  writeJson(path.join(home, 'company.json'), COMPANY);
  writeJson(path.join(home, 'org/departments/ops.json'), DEPT);
  const reg = createDefaultRegistry(home);
  expect((await reg.loadAll()).ok).toBe(true);
  expect(reg.get<{ name: string }>('company')?.name).toBe('Acme');
  expect(reg.get<{ name: string }>('department', 'ops')?.name).toBe('Ops');
});

test('invalid file is rejected with a clear error and last-good stays active', async () => {
  const home = mk();
  const file = path.join(home, 'org/departments/ops.json');
  writeJson(file, DEPT);
  const reg = createDefaultRegistry(home);
  await reg.loadAll();

  writeJson(file, { ...DEPT, autonomy: 'L9' });
  const r = await reg.reloadFile(file);
  expect(r.status).toBe('rejected');
  expect(r.issue?.keptLastGood).toBe(true);
  expect(r.issue?.message).toContain('autonomy');
  expect(reg.get<{ autonomy: string }>('department', 'ops')?.autonomy).toBe('L1');

  // full reload keeps it too, including after unparseable JSON
  fs.writeFileSync(file, '{ not json');
  const all = await reg.loadAll();
  expect(all.ok).toBe(false);
  expect(all.issues[0]?.keptLastGood).toBe(true);
  expect(all.issues[0]?.message).toContain('JSON');
  expect(reg.get('department', 'ops')).toBeDefined();

  // a good edit replaces it; deleting the file removes it
  writeJson(file, { ...DEPT, name: 'Ops 2' });
  expect((await reg.reloadFile(file)).status).toBe('loaded');
  expect(reg.get<{ name: string }>('department', 'ops')?.name).toBe('Ops 2');
  fs.rmSync(file);
  expect((await reg.reloadFile(file)).status).toBe('removed');
  expect(reg.get('department', 'ops')).toBeUndefined();
});

test('a first-time bad file leaves nothing loaded', async () => {
  const home = mk();
  writeJson(path.join(home, 'company.json'), { name: '' });
  const reg = createDefaultRegistry(home);
  const r = await reg.loadAll();
  expect(r.issues[0]?.keptLastGood).toBe(false);
  expect(reg.get('company')).toBeUndefined();
});

test('file name must match the id; unrelated paths are ignored', async () => {
  const home = mk();
  writeJson(path.join(home, 'org/departments/other.json'), DEPT);
  const reg = createDefaultRegistry(home);
  const r = await reg.loadAll();
  expect(r.issues[0]?.message).toContain("does not match the file name");
  expect((await reg.reloadFile(path.join(home, 'brain/wiki/x.json'))).status).toBe('ignored');
});

test('workflow instances under workflows/instances are not loaded as workflows', async () => {
  const home = mk();
  writeJson(path.join(home, 'workflows/instances/abc/state.json'), { whatever: 1 });
  expect((await createDefaultRegistry(home).loadAll()).ok).toBe(true);
});

test('registry is generic: a custom kind works and no org names are hard-coded', async () => {
  const home = mk();
  const reg = new ConfigRegistry(home);
  reg.registerKind({ kind: 'widget', schema: z.strictObject({ id: z.string(), size: z.number() }), dir: 'widgets' });
  reg.registerKind({ kind: 'banner', schema: z.strictObject({ text: z.string() }), file: 'banner.json' });
  writeJson(path.join(home, 'widgets/w1.json'), { id: 'w1', size: 3 });
  writeJson(path.join(home, 'banner.json'), { text: 'hi' });
  expect((await reg.loadAll()).ok).toBe(true);
  expect(reg.get<{ size: number }>('widget', 'w1')?.size).toBe(3);
  expect(reg.get<{ text: string }>('banner')?.text).toBe('hi');
  expect(() => reg.registerKind({ kind: 'widget', schema: z.any(), dir: 'w2' })).toThrow();
  expect(() => reg.registerKind({ kind: 'x', schema: z.any(), dir: 'widgets' })).toThrow();
  expect(() => reg.registerKind({ kind: 'y', schema: z.any() })).toThrow();
  // a bare registry knows no kinds at all
  expect(new ConfigRegistry(home).kindNames()).toEqual([]);
});

test('source has no hard-coded org names or provider names', () => {
  const dir = path.resolve(import.meta.dir, '../../../engine/home');
  const banned = /claude-max|openrouter|ollama|lmstudio|linkedin|youtube|finance|marketing|content/i;
  for (const f of ['registry.ts', 'kinds.ts', 'private-eligible.ts']) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    expect(src, f).not.toMatch(banned);
  }
  expect(KIND_TABLE.length).toBeGreaterThan(5);
});
