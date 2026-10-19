import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../../engine/home/registry.ts';
import { placeholders, resolveParams, slugify, substitute } from '../../../engine/template/params.ts';
import { planImport } from '../../../engine/template/import.ts';
import { cleanupTmp, copyTemplate, freshHomePath, importStarter, readJson, run, tmp, writeJson } from './util.ts';

afterEach(cleanupTmp);

const decl = {
  type: 'object',
  required: ['channelName'],
  properties: {
    channelName: { type: 'string', minLength: 2 },
    mode: { type: 'string', enum: ['api', 'browser', 'manual'], default: 'manual' },
    perWeek: { type: 'integer', default: 2, minimum: 1 },
    dry: { type: 'boolean', default: false },
  },
};

describe('resolveParams', () => {
  test('applies defaults and coerces CLI strings to the declared type', () => {
    expect(resolveParams('t', decl, { channelName: 'My Show', perWeek: '3', dry: 'true' })).toEqual({ channelName: 'My Show', mode: 'manual', perWeek: 3, dry: true });
  });
  test('missing required param is an error that names it', () => {
    expect(() => resolveParams('t', decl, {})).toThrow("missing required param(s) 'channelName'");
  });
  test('type, enum, range and unknown names are rejected', () => {
    expect(() => resolveParams('t', decl, { channelName: 'ok', perWeek: 'x' })).toThrow('type integer');
    expect(() => resolveParams('t', decl, { channelName: 'ok', perWeek: '2.5' })).toThrow('type integer');
    expect(() => resolveParams('t', decl, { channelName: 'ok', mode: 'fax' })).toThrow('must be one of');
    expect(() => resolveParams('t', decl, { channelName: 'ok', perWeek: 0 })).toThrow('below 1');
    expect(() => resolveParams('t', decl, { channelName: 'a' })).toThrow('shorter than 2');
    expect(() => resolveParams('t', decl, { channelName: 'ok', nope: 1 })).toThrow("unknown param(s) 'nope'");
  });
});

describe('substitute', () => {
  const params = { channelName: 'Tech Talks & More', n: 3, on: true };
  test('interpolates inside strings, keeps the type of a whole-string placeholder', () => {
    expect(substitute({ a: 'x {{channelName}} y', b: '{{n}}', c: '{{on}}', d: ['{{n}}'] }, params)).toEqual({ a: 'x Tech Talks & More y', b: 3, c: true, d: [3] });
  });
  test('slug filter', () => {
    expect(substitute('yt-{{channelName|slug}}', params)).toBe('yt-tech-talks-more');
    expect(slugify('  --Hello,  World!! ')).toBe('hello-world');
  });
  test('a param value can not inject JSON structure or more placeholders', () => {
    const out = substitute({ v: '{{x}}' }, { x: '"}, "evil": {{y}}' });
    expect(out).toEqual({ v: '"}, "evil": {{y}}' });
  });
  test('unresolved placeholder and unknown filter name the location', () => {
    expect(() => substitute({ a: ['{{ghost}}'] }, {}, 'tpl/x.json')).toThrow('unresolved placeholder {{ghost}} at tpl/x.json.a[0]');
    expect(() => substitute('{{n|rot13}}', params)).toThrow("unknown filter 'rot13'");
  });
  test('placeholders() lists names', () => {
    expect([...placeholders({ a: '{{x}}', b: ['{{y|slug}} {{x}}'] })].sort()).toEqual(['x', 'y']);
  });
});

describe('params in a real import (team-youtube-channel)', () => {
  test('substitutes channel name and connection mode; no secrets in the result', async () => {
    const home = freshHomePath();
    expect((await importStarter(home)).code).toBe(0);
    const r = await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=Tech Talks', '--param', 'connectionMode=browser', '--apply']);
    expect(r.code).toBe(0);
    const team = readJson(path.join(home, 'org/teams/yt-tech-talks.json'));
    expect(team).toMatchObject({ name: 'YouTube: Tech Talks', managerAgentId: 'yt-tech-talks-manager', memberAgentIds: ['yt-tech-talks-producer', 'yt-tech-talks-editor'], connectionIds: ['yt-tech-talks'], fromTemplate: 'team-youtube-channel' });
    const conn = readJson(path.join(home, 'connections/yt-tech-talks.json'));
    expect(conn.auth).toEqual({ mode: 'browser' });
    expect(conn.status).toBe('pending_confirmation');
    expect(JSON.stringify(conn)).not.toMatch(/secretRef|handle|token/i);
    expect(readJson(path.join(home, 'org/agents/yt-tech-talks-manager.json'))).toMatchObject({ roleId: 'channel-manager', parentAgentId: 'dir-content', departmentId: 'content' });
    expect((await createDefaultRegistry(home).loadAll()).issues).toEqual([]);
    expect(readJson(path.join(home, 'templates/installed/team-youtube-channel.json')).params).toMatchObject({ channelName: 'Tech Talks', connectionMode: 'browser' });
  });

  test('default connection mode is manual; a second channel is a second team', async () => {
    const home = freshHomePath();
    await importStarter(home);
    await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=One', '--apply']);
    // the install record is per template, so a second channel is a second import with other params
    const again = await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=Two', '--preview']);
    expect(again.out).toContain('+ team/yt-two');
    expect(readJson(path.join(home, 'connections/yt-one.json')).auth.mode).toBe('manual');
  });

  test('missing required param fails with a clear error and writes nothing', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const r = await run(['import', 'team-youtube-channel', '--home', home, '--apply']);
    expect(r.code).toBe(1);
    expect(r.err).toContain("missing required param(s) 'channelName'");
    expect(fs.existsSync(path.join(home, 'org/teams/yt-tech-talks.json'))).toBe(false);
  });

  test('bad value, unknown param and out-of-set connection mode', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const base = ['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=Ok Show'];
    expect((await run([...base, '--param', 'connectionMode=pigeon'])).err).toContain('must be one of');
    expect((await run([...base, '--param', 'bogus=1'])).err).toContain("not declared by any selected template");
    expect((await run([...base, '--param', 'team-youtube-channel:bogus=1'])).err).toContain("unknown param(s) 'bogus'");
    expect((await run([...base, '--param', 'ghost-template:x=1'])).err).toContain('is not part of this import');
    expect((await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=!!'])).err).toContain('does not match');
  });

  test('an undeclared {{placeholder}} inside a template file is an error', async () => {
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const w = readJson(path.join(dir, 'roles/writer.json'));
    w.dutiesPrompt = 'Hello {{stranger}}';
    writeJson(path.join(dir, 'roles/writer.json'), w);
    const plan = await planImport({ home: freshHomePath(), templates: ['roles-content'], roots: [root] });
    expect(plan.errors.join('\n')).toContain('{{stranger}} is not a declared param');
  });
});
