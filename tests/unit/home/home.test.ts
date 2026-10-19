import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { HOME_DIRS, initHome, REQUIRED_GITIGNORE } from '../../../engine/home/home.ts';
import { createDefaultRegistry } from '../../../engine/home/registry.ts';
import { keysInit } from '../../../engine/home/keys.ts';
import { fakeRunner, tmpHome } from './util.ts';
import { realRunner } from '../../../engine/home/run.ts';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const mk = () => {
  const t = tmpHome();
  cleanups.push(t.cleanup);
  return t;
};

test('initHome creates the layout, a git repo and the .gitignore', () => {
  const { home } = mk();
  const r = initHome({ home });
  expect(r.createdHome && r.gitInitialized).toBe(true);
  for (const { dir } of HOME_DIRS) expect(fs.statSync(path.join(home, dir)).isDirectory()).toBe(true);
  expect(fs.existsSync(path.join(home, '.git', 'HEAD'))).toBe(true);
  expect(fs.statSync(path.join(home, 'private')).mode & 0o777).toBe(0o700);
  expect(fs.statSync(path.join(home, 'exec')).mode & 0o777).toBe(0o700);
  const lines = fs.readFileSync(path.join(home, '.gitignore'), 'utf8').split('\n');
  for (const l of REQUIRED_GITIGNORE) expect(lines).toContain(l);
  expect(lines).toContain('private/');
  expect(lines).toContain('exec/');
});

test('git really ignores private/ and exec/', () => {
  const { home } = mk();
  initHome({ home });
  fs.writeFileSync(path.join(home, 'private', 'k.txt'), 'x');
  fs.writeFileSync(path.join(home, 'exec', 'e.txt'), 'x');
  expect(realRunner('git', ['check-ignore', '-q', 'private/k.txt'], { cwd: home }).code).toBe(0);
  expect(realRunner('git', ['check-ignore', '-q', 'exec/e.txt'], { cwd: home }).code).toBe(0);
});

test('initHome is idempotent and keeps owner lines in .gitignore', () => {
  const { home } = mk();
  initHome({ home });
  const gi = path.join(home, '.gitignore');
  fs.appendFileSync(gi, 'my-own-line\n');
  fs.writeFileSync(path.join(home, 'org', 'departments', 'keep.json'), '{}');
  const before = fs.readFileSync(gi, 'utf8');
  const r2 = initHome({ home });
  expect(r2.createdHome || r2.gitInitialized || r2.gitignoreChanged).toBe(false);
  expect(fs.readFileSync(gi, 'utf8')).toBe(before);
  expect(fs.existsSync(path.join(home, 'org', 'departments', 'keep.json'))).toBe(true);
  // a missing required line is restored without dropping the owner's
  fs.writeFileSync(gi, 'my-own-line\n');
  expect(initHome({ home }).gitignoreChanged).toBe(true);
  const after = fs.readFileSync(gi, 'utf8').split('\n');
  expect(after).toContain('my-own-line');
  expect(after).toContain('private/');
});

test('init writes no key material', () => {
  const { home } = mk();
  initHome({ home });
  expect(fs.readdirSync(path.join(home, 'private'))).toEqual([]);
});

test('an empty home boots an empty company with no errors', async () => {
  const { home } = mk();
  initHome({ home });
  const reg = createDefaultRegistry(home);
  const r = await reg.loadAll();
  expect(r).toEqual({ ok: true, issues: [] });
  for (const k of ['department', 'team', 'workflow', 'agent']) expect(reg.all(k)).toEqual({});
  expect(reg.get('company')).toBeUndefined();
});

test('a home dir that does not exist yet also loads empty', async () => {
  const { home } = mk();
  expect((await createDefaultRegistry(home).loadAll()).ok).toBe(true);
});

test('keys init: not installed -> clear message, nothing written', () => {
  const { home } = mk();
  initHome({ home });
  const r = keysInit({ home, run: fakeRunner({}) });
  expect(r.status).toBe('not_installed');
  expect(fs.readdirSync(path.join(home, 'private'))).toEqual([]);
});

const hasAge = realRunner('age-keygen', ['--version']).code === 0;
test.skipIf(!hasAge)('keys init: creates a 0600 identity once, never overwrites', () => {
  const { home } = mk();
  initHome({ home });
  const a = keysInit({ home });
  expect(a.status).toBe('created');
  if (a.status === 'not_installed') return;
  expect(fs.statSync(a.identityPath).mode & 0o777).toBe(0o600);
  expect(a.recipient).toMatch(/^age1/);
  const content = fs.readFileSync(a.identityPath, 'utf8');
  const b = keysInit({ home });
  expect(b.status).toBe('exists');
  expect(fs.readFileSync(a.identityPath, 'utf8')).toBe(content);
  expect(realRunner('git', ['check-ignore', '-q', 'private/age-identity.txt'], { cwd: home }).code).toBe(0);
});
