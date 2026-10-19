import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { createDefaultRegistry } from '../../../engine/home/registry.ts';
import { realRunner } from '../../../engine/home/run.ts';
import { applyPlan, planImport } from '../../../engine/template/import.ts';
import { cleanupTmp, copyTemplate, freshHomePath, git, importStarter, readJson, run, STARTER, tmp, walkFiles, writeJson } from './util.ts';

afterEach(cleanupTmp);

describe('import into an empty home', () => {
  test('creates the full-life org, validated by the P0-6 registry, in ONE commit', async () => {
    const home = freshHomePath();
    const r = await importStarter(home);
    expect(r.code).toBe(0);
    expect(r.out).toContain('applied: commit');

    const reg = createDefaultRegistry(home);
    expect((await reg.loadAll()).issues).toEqual([]);
    const snap = reg.snapshot();
    expect(Object.keys(snap.agent!).length).toBe(27);
    expect(Object.keys(snap.department!).sort()).toEqual(['brain', 'ceo-office', 'content', 'council', 'engineering', 'security']);
    expect(Object.keys(snap.team!).length).toBe(6);
    expect(snap.agent!.cos).toMatchObject({ parentAgentId: null, departmentId: 'ceo-office' });
    expect(snap.agent!.tej).toBeUndefined(); // the Owner is never an agent
    expect(snap.providers).toHaveProperty('providers');
    expect(Object.keys(snap.role!)).toContain('writer'); // from roles-content
    expect(Object.keys(snap.role!)).toContain('reviewer'); // from roles-verification

    expect(git(home, 'rev-list', '--count', 'HEAD')).toBe('1');
    expect(git(home, 'status', '--porcelain')).toBe('');
    expect(git(home, 'log', '-1', '--format=%s')).toContain('template import: org-full-life@1.0.0');
  });

  test('preview writes nothing, not even the home', async () => {
    const home = freshHomePath();
    const r = await run(['import', ...STARTER, '--home', home, '--preview']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('+ agent/cos');
    expect(r.out).toContain('preview only');
    expect(fs.existsSync(home)).toBe(false);
  });

  test('default mode is preview', async () => {
    const home = freshHomePath();
    const r = await run(['import', 'defaults-v1', '--home', home]);
    expect(r.code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });

  test('works with no git identity configured (neutral local identity)', async () => {
    const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', HOME: tmp('nohome') } as Record<string, string>;
    for (const n of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[n];
    const bare: typeof realRunner = (cmd, args, opts) => {
      const r = Bun.spawnSync([cmd, ...args], { cwd: opts?.cwd, env, stdout: 'pipe', stderr: 'pipe', stdin: 'ignore' });
      return { code: r.exitCode ?? 1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    };
    const home = freshHomePath();
    await applyPlan(await planImport({ home, templates: STARTER }), { run: bare });
    expect(git(home, 'log', '-1', '--format=%an <%ae>')).toBe('fleet <fleet@localhost>');
  });
});

describe('idempotence', () => {
  test('re-import shows "no changes" and makes no commit', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const before = git(home, 'rev-parse', 'HEAD');
    const again = await importStarter(home);
    expect(again.code).toBe(0);
    expect(again.out).toContain('no changes');
    expect(again.out).toContain('0 added, 0 changed');
    expect(git(home, 'rev-parse', 'HEAD')).toBe(before);
    const preview = await run(['import', ...STARTER, '--home', home, '--preview']);
    expect(preview.out).toContain('no changes');
  });

  test('a newer template version updates objects it installed (changed, not a conflict)', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const m = readJson(path.join(dir, 'template.json'));
    m.version = '1.1.0';
    writeJson(path.join(dir, 'template.json'), m);
    const w = readJson(path.join(dir, 'roles/writer.json'));
    w.dutiesPrompt = 'Draft into staging/posts/. Short and plain.';
    writeJson(path.join(dir, 'roles/writer.json'), w);

    const r = await run(['import', 'roles-content', '--home', home, '--templates-dir', root, '--apply']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('~ role/writer');
    expect(readJson(path.join(home, 'org/roles/writer.json')).dutiesPrompt).toBe('Draft into staging/posts/. Short and plain.');
    expect(readJson(path.join(home, 'templates/installed/roles-content.json')).version).toBe('1.1.0');
    expect(git(home, 'rev-list', '--count', 'HEAD')).toBe('2');
  });
});

describe('conflicts', () => {
  test('an edited object is a conflict: shown, apply refused, nothing written until resolved', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const file = path.join(home, 'org/roles/writer.json');
    const edited = readJson(file);
    edited.dutiesPrompt = 'my own prompt';
    writeJson(file, edited);
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const m = readJson(path.join(dir, 'template.json'));
    m.version = '1.1.0';
    writeJson(path.join(dir, 'template.json'), m);
    const w = readJson(path.join(dir, 'roles/writer.json'));
    w.dutiesPrompt = 'template prompt v2';
    writeJson(path.join(dir, 'roles/writer.json'), w);
    const head = git(home, 'rev-parse', 'HEAD');
    const args = ['import', 'roles-content', '--home', home, '--templates-dir', root];

    const preview = await run([...args, '--preview']);
    expect(preview.code).toBe(0);
    expect(preview.out).toContain('! role/writer');
    expect(preview.out).toContain('CONFLICT');
    expect(preview.out).toContain('1 conflict');

    const apply = await run([...args, '--apply']);
    expect(apply.code).toBe(1);
    expect(apply.err).toContain('unresolved conflicts');
    expect(readJson(file).dutiesPrompt).toBe('my own prompt');
    expect(git(home, 'rev-parse', 'HEAD')).toBe(head);
    expect(readJson(path.join(home, 'templates/installed/roles-content.json')).version).toBe('1.0.0');

    // resolve: skip keeps my edit
    const skip = await run([...args, '--apply', '--resolve', 'role/writer=skip']);
    expect(skip.code).toBe(0);
    expect(readJson(file).dutiesPrompt).toBe('my own prompt');

    // resolve: overwrite takes the template's version, in one more commit
    const over = await run([...args, '--apply', '--resolve', 'role/writer=overwrite']);
    expect(over.code).toBe(0);
    expect(readJson(file).dutiesPrompt).toBe('template prompt v2');
    expect(git(home, 'rev-list', '--count', 'HEAD')).toBe('3'); // import, skip (record bump), overwrite
  });

  test('an object that exists but was never installed by the template is a conflict', async () => {
    const home = freshHomePath();
    writeJson(path.join(home, 'org/roles/writer.json'), { ...readJson(path.join(copyTemplate('roles-content', tmp()), 'roles/writer.json')), dutiesPrompt: 'hand written' });
    const plan = await planImport({ home, templates: ['roles-content'] });
    const c = plan.items.find((i) => i.id === 'writer')!;
    expect(c.status).toBe('conflict');
    expect(c.reason).toContain('not installed by this template');
    await expect(applyPlan(plan)).rejects.toThrow('unresolved conflicts');
    expect(fs.existsSync(path.join(home, '.git'))).toBe(false); // refused before touching the home
  });

  test('--answers file carries params and resolutions', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const answers = path.join(tmp(), 'answers.json');
    writeJson(answers, { params: { channelName: 'Tech Talks' }, resolutions: {} });
    const r = await run(['import', 'team-youtube-channel', '--home', home, '--answers', answers, '--apply']);
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(home, 'org/teams/yt-tech-talks.json'))).toBe(true);
    writeJson(answers, { oops: 1 });
    expect((await run(['import', 'defaults-v1', '--home', home, '--answers', answers])).code).toBe(2);
  });
});

describe('atomic apply', () => {
  test('one invalid object means nothing is written', async () => {
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const bad = readJson(path.join(dir, 'roles/writer.json'));
    bad.tier = 'deep';
    bad.maxTier = 'cheap'; // tier above maxTier
    writeJson(path.join(dir, 'roles/writer.json'), bad);
    const home = freshHomePath();
    const r = await run(['import', 'roles-content', '--home', home, '--templates-dir', root, '--apply']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('default tier is above maxTier');
    expect(fs.existsSync(path.join(home, 'org/roles/editor.json'))).toBe(false);
    expect(fs.existsSync(home)).toBe(false);
  });

  test('a failing commit rolls every written file back', async () => {
    const home = freshHomePath();
    const failing: typeof realRunner = (cmd, args, opts) => (cmd === 'git' && args.includes('commit') ? { code: 1, stdout: '', stderr: 'boom' } : realRunner(cmd, args, opts));
    const plan = await planImport({ home, templates: STARTER });
    await expect(applyPlan(plan, { run: failing })).rejects.toThrow('boom');
    const left = walkFiles(home).filter((f) => f.endsWith('.json'));
    expect(left).toEqual([]);
    expect(git(home, 'status', '--porcelain')).toBe('?? .gitignore'); // only init's .gitignore is left; nothing staged
  });

  test('a registry rejection after writing rolls back (existing file restored)', async () => {
    const home = freshHomePath();
    await importStarter(home);
    // make the on-disk company invalid for the registry's id/filename rule: the file name must match the id
    const root = tmp();
    const dir = copyTemplate('roles-content', root);
    const m = readJson(path.join(dir, 'template.json'));
    m.version = '9.9.9';
    writeJson(path.join(dir, 'template.json'), m);
    const w = readJson(path.join(dir, 'roles/writer.json'));
    w.dutiesPrompt = 'v9';
    writeJson(path.join(dir, 'roles/writer.json'), w);
    const plan = await planImport({ home, templates: ['roles-content'], roots: [root] });
    // sabotage: pretend the planned file lands under another name than its id
    plan.items.find((i) => i.id === 'writer')!.file = 'org/roles/not-writer.json';
    const before = fs.readFileSync(path.join(home, 'org/roles/writer.json'), 'utf8');
    await expect(applyPlan(plan)).rejects.toThrow('registry rejected');
    expect(fs.readFileSync(path.join(home, 'org/roles/writer.json'), 'utf8')).toBe(before);
    expect(fs.existsSync(path.join(home, 'org/roles/not-writer.json'))).toBe(false);
  });
});

describe('requires and references', () => {
  test('requires.templates must be selected or installed', async () => {
    const plan = await planImport({ home: freshHomePath(), templates: ['org-full-life'] });
    expect(plan.errors.join('\n')).toContain("requires template 'roles-content'");
    expect(plan.errors.join('\n')).toContain("requires template 'roles-verification'");
  });

  test('an agent whose role is missing is reported, nothing applied', async () => {
    const home = freshHomePath();
    const r = await run(['import', 'team-youtube-channel', '--home', home, '--param', 'channelName=Solo', '--apply']);
    expect(r.code).toBe(1);
    expect(r.out).toContain("role 'channel-manager', which does not exist");
    expect(r.out).toContain("department 'content', which does not exist");
    expect(fs.existsSync(home)).toBe(false);
  });
});
