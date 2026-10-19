import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { doctorExitCode, formatChecks, runDoctor, versionAtLeast, type Check } from '../../../engine/home/doctor.ts';
import { append } from '../../../engine/lib/chain.ts';
import { COMPANY, fakeRunner, initedHome, writeJson } from './util.ts';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const mk = () => {
  const t = initedHome();
  cleanups.push(t.cleanup);
  return t.home;
};

const FV_ON = fakeRunner({ fdesetup: { stdout: 'FileVault is On.\n' }, age: { stdout: '1.1.1' }, 'age-keygen': { stdout: '1.1.1' } });
const by = (cs: Check[], name: string) => cs.find((c) => c.name === name)!;

test('healthy home on macOS with FileVault: no failures', async () => {
  const home = mk();
  const cs = await runDoctor({ home, run: FV_ON, platform: 'darwin', env: {}, bunVersion: '1.4.3' });
  expect(cs.filter((c) => c.status === 'fail')).toEqual([]);
  expect(doctorExitCode(cs)).toBe(0);
  expect(by(cs, 'disk encryption').status).toBe('pass');
  expect(by(cs, 'age installed').status).toBe('pass');
  expect(formatChecks(cs)).toContain('[pass] home is a git repo');
});

test('doctor fails on an unencrypted disk (macOS)', async () => {
  const run = fakeRunner({ fdesetup: { stdout: 'FileVault is Off.\n' } });
  const cs = await runDoctor({ home: mk(), run, platform: 'darwin', env: {}, bunVersion: '1.4.3' });
  expect(by(cs, 'disk encryption').status).toBe('fail');
  expect(doctorExitCode(cs)).toBe(1);
});

const lsblk = (tree: unknown) => fakeRunner({ lsblk: { stdout: JSON.stringify({ blockdevices: tree }) } });

test('Linux: encrypted root passes, plain root fails, no match warns', async () => {
  const home = mk();
  const enc = lsblk([{ name: 'root', type: 'lvm', mountpoints: ['/'], children: [{ name: 'luks', type: 'crypt', mountpoints: [null], children: [{ name: 'sda2', type: 'part' }] }] }]);
  const plain = lsblk([{ name: 'sda1', type: 'part', mountpoints: ['/'], children: [{ name: 'sda', type: 'disk' }] }]);
  const none = lsblk([{ name: 'sdb1', type: 'part', mountpoints: ['/mnt/other'] }]);
  expect(by(await runDoctor({ home, run: enc, platform: 'linux', env: {}, bunVersion: '1.4.3' }), 'disk encryption').status).toBe('pass');
  const bad = await runDoctor({ home, run: plain, platform: 'linux', env: {}, bunVersion: '1.4.3' });
  expect(by(bad, 'disk encryption').status).toBe('fail');
  expect(doctorExitCode(bad)).toBe(1);
  expect(by(await runDoctor({ home, run: none, platform: 'linux', env: {}, bunVersion: '1.4.3' }), 'disk encryption').status).toBe('warn');
  expect(by(await runDoctor({ home, run: fakeRunner({}), platform: 'linux', env: {}, bunVersion: '1.4.3' }), 'disk encryption').status).toBe('warn');
  expect(by(await runDoctor({ home, run: FV_ON, platform: 'win32', env: {}, bunVersion: '1.4.3' }), 'disk encryption').status).toBe('warn');
});

test('missing age is a warning, not a failure', async () => {
  const cs = await runDoctor({ home: mk(), run: fakeRunner({ fdesetup: { stdout: 'FileVault is On.' } }), platform: 'darwin', env: {}, bunVersion: '1.4.3' });
  expect(by(cs, 'age installed').status).toBe('warn');
  expect(by(cs, 'age installed').detail).toContain('not installed');
  expect(doctorExitCode(cs)).toBe(0);
});

test('secrets in env warn by name only, never value', async () => {
  const env = { OPENAI_API_KEY: 'sk-secret-value', PATH: '/bin', GITHUB_TOKEN: 'ghp_x', EMPTY_API_KEY: '' };
  const cs = await runDoctor({ home: mk(), run: FV_ON, platform: 'darwin', env, bunVersion: '1.4.3' });
  const c = by(cs, 'no secrets in env');
  expect(c.status).toBe('warn');
  expect(c.detail).toContain('OPENAI_API_KEY');
  expect(c.detail).toContain('GITHUB_TOKEN');
  expect(c.detail).not.toContain('sk-secret-value');
  expect(c.detail).not.toContain('EMPTY_API_KEY');
});

test('failures: missing home, not a repo, bad .gitignore, loose private mode, bad config, old bun, broken chain', async () => {
  const gone = await runDoctor({ home: '/nonexistent-fleet-home-xyz', run: FV_ON, platform: 'darwin', env: {}, bunVersion: '1.4.3' });
  expect(by(gone, 'home exists').status).toBe('fail');

  const home = mk();
  fs.rmSync(path.join(home, '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, '.gitignore'), 'state/\n');
  fs.chmodSync(path.join(home, 'private'), 0o755);
  writeJson(path.join(home, 'company.json'), { ...COMPANY, name: '' });
  await append(path.join(home, 'audit/audit.jsonl'), { actor: 'x', action: 'a', target: 't', outcome: 'ok' });
  const f = path.join(home, 'audit/audit.jsonl');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('"actor":"x"', '"actor":"y"'));
  const cs = await runDoctor({ home, run: FV_ON, platform: 'darwin', env: {}, bunVersion: '1.0.9' });
  for (const n of ['home is a git repo', '.gitignore excludes private/ and exec/', 'private/ mode 0700', 'config validates', 'bun version', 'audit chains verify']) {
    expect(by(cs, n).status, n).toBe('fail');
  }
  expect(doctorExitCode(cs)).toBe(1);
});

test('versionAtLeast', () => {
  expect(versionAtLeast('1.4.3', '1.1.0')).toBe(true);
  expect(versionAtLeast('1.1.0', '1.1.0')).toBe(true);
  expect(versionAtLeast('1.0.36', '1.1.0')).toBe(false);
  expect(versionAtLeast('2.0.0', '1.9.9')).toBe(true);
});

test('doctor CLI runs against a temp home and exits 1 when it is missing', () => {
  const home = mk();
  const bin = path.resolve(import.meta.dir, '../../../engine/bin/doctor.ts');
  const r = Bun.spawnSync(['bun', bin], { env: { PATH: process.env.PATH!, FLEET_HOME: path.join(home, 'nope') }, stdout: 'pipe', stderr: 'pipe' });
  expect(r.exitCode).toBe(1);
  expect(r.stdout.toString()).toContain('[fail] home exists');
});
