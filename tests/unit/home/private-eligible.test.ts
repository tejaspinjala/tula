import { afterEach, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../../engine/home/registry.ts';
import { confirmPrivateProvider, CONFIRMATIONS_FILE, isLoopbackUrl } from '../../../engine/home/private-eligible.ts';
import { entryHash } from '../../../engine/lib/chain.ts';
import { initedHome, provider, providersFile, writeJson } from './util.ts';

const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((c) => c()));
const mk = () => {
  const t = initedHome();
  cleanups.push(t.cleanup);
  return t.home;
};
const PF = 'org/providers.json';
const priv = { dataClasses: ['public', 'internal', 'private'], privateEligible: true };

async function load(home: string, providers: Record<string, unknown>) {
  writeJson(path.join(home, PF), providersFile(providers));
  const reg = createDefaultRegistry(home);
  const r = await reg.loadAll();
  return { reg, r };
}

test('claude-code on a subscription is private-eligible', async () => {
  const { r } = await load(mk(), { 'prov-a': provider({ adapter: 'claude-code', auth: 'subscription', baseUrl: undefined, ...priv }) });
  expect(r.ok).toBe(true);
});

test('claude-code with an API key is NOT Claude Max', async () => {
  const { r, reg } = await load(mk(), { 'prov-a': provider({ adapter: 'claude-code', auth: 'api_key', baseUrl: undefined, ...priv }) });
  expect(r.ok).toBe(false);
  expect(r.issues[0]?.message).toContain("provider 'prov-a'");
  expect(reg.get('providers')).toBeUndefined();
});

test('loopback endpoints are eligible', async () => {
  for (const baseUrl of ['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1', 'http://[::1]:8080/v1', 'http://127.5.5.5/v1']) {
    const { r } = await load(mk(), { 'prov-a': provider({ baseUrl, ...priv }) });
    expect(r.ok, baseUrl).toBe(true);
  }
});

test('tricky hosts are not loopback', () => {
  for (const u of ['https://localhost.evil.com/v1', 'https://127.0.0.1.evil.com/v1', 'https://example.com', 'nonsense', undefined]) {
    expect(isLoopbackUrl(u), String(u)).toBe(false);
  }
});

test('privateEligible false never needs anything', async () => {
  expect((await load(mk(), { 'prov-a': provider() })).r.ok).toBe(true);
});

test('remote openai-compatible is refused, then accepted with an owner confirmation', async () => {
  const home = mk();
  const p = { remote: provider({ ...priv }) };
  const a = await load(home, p);
  expect(a.r.ok).toBe(false);
  expect(a.r.issues[0]?.message).toContain('confirm-private-provider remote');

  await confirmPrivateProvider('remote', { home });
  const b = await load(home, p);
  expect(b.r).toEqual({ ok: true, issues: [] });
  expect(Object.keys(b.reg.all('providers'))).toEqual(['providers']);

  const rec = JSON.parse(fs.readFileSync(path.join(home, CONFIRMATIONS_FILE), 'utf8').trim().split('\n')[0]!);
  expect(rec.payload.decidedBy).toBe('owner');
  expect(fs.readFileSync(path.join(home, 'audit/audit.jsonl'), 'utf8')).toContain('private_provider.confirm');
});

test('a confirmation does not carry over to a changed endpoint or another id', async () => {
  const home = mk();
  await load(home, { remote: provider({ ...priv }) });
  await confirmPrivateProvider('remote', { home });
  expect((await load(home, { remote: provider({ ...priv, baseUrl: 'https://other.example.com/v1' }) })).r.ok).toBe(false);
  expect((await load(home, { renamed: provider({ ...priv }) })).r.ok).toBe(false);
});

test('forged confirmation records are refused', async () => {
  const home = mk();
  const p = { remote: provider({ ...priv }) };
  await load(home, p);
  const file = path.join(home, CONFIRMATIONS_FILE);

  // 1. hand-written line with a made-up hash
  fs.writeFileSync(file, JSON.stringify({ seq: 1, ts: new Date().toISOString(), prevHash: '0'.repeat(64), payload: { kind: 'private_provider_confirmation', providerId: 'remote', decidedBy: 'owner', fingerprint: 'x' }, hash: 'f'.repeat(64) }) + '\n');
  expect((await load(home, p)).r.ok).toBe(false);

  // 2. a real confirmation whose payload was edited afterwards (chain breaks)
  fs.rmSync(file);
  await confirmPrivateProvider('remote', { home });
  expect((await load(home, p)).r.ok).toBe(true);
  const good = fs.readFileSync(file, 'utf8');
  fs.writeFileSync(file, good.replace('"providerId":"remote"', '"providerId":"remote2"'));
  expect((await load(home, p)).r.ok).toBe(false);

  // 3. chain-valid but decided by someone other than the owner
  const e = { seq: 1, ts: new Date().toISOString(), prevHash: '0'.repeat(64), payload: { kind: 'private_provider_confirmation', providerId: 'remote', decidedBy: 'agent', fingerprint: JSON.parse(good).payload.fingerprint } };
  fs.writeFileSync(file, JSON.stringify({ ...e, hash: entryHash(e) }) + '\n');
  expect((await load(home, p)).r.ok).toBe(false);
});

test('confirm API refuses things that need no confirmation or do not exist', async () => {
  const home = mk();
  await load(home, { loop: provider({ baseUrl: 'http://127.0.0.1:1/v1', ...priv }), off: provider() });
  await expect(confirmPrivateProvider('loop', { home })).rejects.toThrow('by default');
  await expect(confirmPrivateProvider('off', { home })).rejects.toThrow('does not set privateEligible');
  await expect(confirmPrivateProvider('nope', { home })).rejects.toThrow('no provider');
});
