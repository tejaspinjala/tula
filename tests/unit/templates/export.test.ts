import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../../engine/home/registry.ts';
import { readTree } from '../../../engine/template/tree.ts';
import { cleanupTmp, freshHomePath, importStarter, readJson, run, tmp, walkFiles, writeJson } from './util.ts';

afterEach(cleanupTmp);

const PLANTED = {
  handle: '@plantedhandle',
  url: 'https://www.youtube.com/@plantedhandle',
  channelId: 'UCplantedChannelId9876',
  secretKey: 'PLANTED_REFRESH_KEY',
  secretPath: '/planted-path/secrets',
  profile: 'planted-browser-profile',
  providerRef: 'providers/PLANTED_PROVIDER_KEY',
  token: 'sk-live-PLANTEDabcdef1234567890xyz',
};

/** A home with the starter org plus a YouTube team whose connection carries planted handles and secret refs. */
async function plantedHome(): Promise<string> {
  const home = freshHomePath();
  expect((await importStarter(home)).code).toBe(0);
  expect((await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=Planted Show', '--apply'])).code).toBe(0);
  const connFile = path.join(home, 'connections/yt-planted-show.json');
  const conn = readJson(connFile);
  conn.account = { displayName: `Planted ${PLANTED.handle}`, handle: PLANTED.handle, url: PLANTED.url, owner: 'llc' };
  conn.auth = {
    mode: 'api',
    identity: 'publisherd',
    secretRefs: [{ field: 'refresh_token', project: 'tula-fleet', environment: 'laptop', path: PLANTED.secretPath, key: PLANTED.secretKey }],
  };
  conn.posting = { mode: 'approve_then_auto', dailyLimit: 3 };
  conn.config = { channelId: PLANTED.channelId };
  conn.health = { status: 'ok', detail: PLANTED.handle };
  conn.status = 'active';
  writeJson(connFile, conn);
  // a provider with a secret ref
  const provFile = path.join(home, 'org/providers.json');
  const prov = readJson(provFile);
  prov.providers.openrouter = { adapter: 'fleet-loop', baseUrl: 'https://openrouter.ai/api/v1', secretRef: PLANTED.providerRef, tiers: { cheap: 'small' }, dataClasses: ['public'], privateEligible: false };
  writeJson(provFile, prov);
  // a prompt that accidentally holds a credential value
  const roleFile = path.join(home, 'org/roles/writer.json');
  const role = readJson(roleFile);
  role.dutiesPrompt = `Draft posts. api_key=${PLANTED.token} stays secret.`;
  writeJson(roleFile, role);
  // a config file that is really a link into private/
  fs.mkdirSync(path.join(home, 'private'), { recursive: true });
  const leaked = { ...readJson(path.join(home, 'org/roles/editor.json')), id: 'leaky', title: 'Leaky PRIVATE-ONLY-TITLE' };
  writeJson(path.join(home, 'private/leaky.json'), leaked);
  fs.symlinkSync(path.join(home, 'private/leaky.json'), path.join(home, 'org/roles/leaky.json'));
  expect((await createDefaultRegistry(home).loadAll()).issues).toEqual([]);
  return home;
}

describe('export', () => {
  test('strips secret refs/values, handles, account ids and private/; round-trips into an empty home', async () => {
    const home = await plantedHome();
    const out = path.join(tmp(), 'exported');
    const r = await run(['export', 'my-company', '--home', home, '--out', out, '--title', 'My company']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('skipped role/leaky (under private/)');
    expect(r.out).toContain('redacted role/writer');

    // 1. the planted strings are in NO exported file
    const text = walkFiles(out).map((f) => fs.readFileSync(f, 'utf8')).join('\n');
    for (const [name, s] of Object.entries(PLANTED)) expect([name, text.includes(s)]).toEqual([name, false]);
    expect(text).not.toContain('PRIVATE-ONLY-TITLE');
    expect(text).not.toContain('secretRefs');
    expect(text).not.toContain('profileId');
    expect(fs.existsSync(path.join(out, 'objects/role/leaky.json'))).toBe(false);

    // 2. the connection keeps only structure and is safe to import (manual posting, pending)
    const conn = readJson(path.join(out, 'objects/connection/yt-planted-show.json'));
    expect(conn.account).toEqual({ displayName: 'yt-planted-show', owner: 'llc' });
    expect(conn.auth).toEqual({ mode: 'api' });
    expect(conn.posting.mode).toBe('manual');
    expect(conn.status).toBe('pending_confirmation');

    // 3. import into an empty home: same org, still no planted strings anywhere
    const fresh = freshHomePath();
    const imp = await run(['import', out, '--home', fresh, '--apply']);
    expect(imp.code).toBe(0);
    const tree = readTree(fresh);
    const all = Object.values(tree).join('\n');
    for (const s of Object.values(PLANTED)) expect(all.includes(s)).toBe(false);
    const a = createDefaultRegistry(home);
    const b = createDefaultRegistry(fresh);
    await a.loadAll();
    await b.loadAll();
    for (const kind of ['department', 'team', 'agent', 'role']) {
      const orig = { ...a.all(kind) } as Record<string, unknown>;
      delete orig.leaky;
      if (kind === 'role') expect(Object.keys(b.all(kind)).sort()).toEqual(Object.keys(orig).sort());
      else expect(b.all(kind)).toEqual(orig);
    }
    expect(Object.keys(b.all('connection'))).toEqual(['yt-planted-show']);
    expect(b.get<{ prompt?: string; dutiesPrompt: string }>('role', 'writer')!.dutiesPrompt).toBe('<redacted>');
    expect(Object.keys(b.get<{ providers: object }>('providers')!.providers).sort()).toEqual(['claude-max', 'openrouter']);
    expect((b.get<{ providers: Record<string, { secretRef?: string }> }>('providers')!.providers.openrouter!).secretRef).toBeUndefined();
  });

  test('--kind and --only narrow the export; unknown things fail', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const out = path.join(tmp(), 'roles');
    expect((await run(['export', 'just-roles', '--home', home, '--out', out, '--kind', 'role', '--only', 'role/writer', '--only', 'role/editor'])).code).toBe(0);
    expect(readJson(path.join(out, 'template.json')).kinds).toEqual(['role']);
    expect(walkFiles(out).filter((f) => f.endsWith('.json')).length).toBe(3);
    expect((await run(['export', 'x-y', '--home', home, '--out', path.join(tmp(), 'o'), '--only', 'role/ghost'])).err).toContain('role/ghost not found');
    expect((await run(['export', 'x-y', '--home', home, '--out', path.join(tmp(), 'o'), '--kind', 'company'])).err).toContain("kind 'company' can not be exported");
  });

  test('refuses a non-empty output dir and an empty home', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const out = tmp();
    fs.writeFileSync(path.join(out, 'keep.txt'), 'x');
    expect((await run(['export', 'x-y', '--home', home, '--out', out])).err).toContain('is not empty');
    const empty = freshHomePath();
    fs.mkdirSync(empty, { recursive: true });
    expect((await run(['export', 'x-y', '--home', empty, '--out', path.join(tmp(), 'o')])).err).toContain('nothing to export');
  });
});
