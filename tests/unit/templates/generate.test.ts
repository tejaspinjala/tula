import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { GENERATED_MARKER, loadOrg, main, renderAll, syncAgents } from '../../../engine/adapters/claude-code/generate.ts';
import { buildExampleTree, exampleTemplates } from '../../../engine/template/example.ts';
import { readTree } from '../../../engine/template/tree.ts';
import { repoRoot } from '../../helpers.ts';
import { cleanupTmp, freshHomePath, importStarter, run, STARTER, tmp, writeJson } from './util.ts';

afterEach(cleanupTmp);

const common = 'COMMON RULES';

describe('generator: two different orgs', () => {
  test('full-life org: one file per agent, equal to the checked-in .claude/agents', async () => {
    const home = freshHomePath();
    await importStarter(home);
    const { org, models, provider } = await loadOrg(home);
    expect(provider).toBe('claude-max');
    expect(models).toEqual({ cheap: 'haiku', mid: 'sonnet', deep: 'opus' });
    expect(org.nodes.length).toBe(27);
    const common2 = fs.readFileSync(path.join(repoRoot, 'engine/prompts/common.md'), 'utf8').trim();
    const out = renderAll(org, models, common2);
    for (const f of out) expect([f.file, fs.readFileSync(path.join(repoRoot, f.file), 'utf8')]).toEqual([f.file, f.text]);
    const cos = out.find((o) => o.file.endsWith('cos.md'))!.text;
    expect(cos).toContain('model: opus');
    expect(cos).toContain('tools: Read, Grep, Glob, Write, Agent(council-chair, dir-brain, dir-content, dir-eng, dir-sec)');
    expect(cos).not.toMatch(/Tej/);
    // a leaf loses the Agent tool
    expect(out.find((o) => o.file.endsWith('e-coder.md'))!.text).toContain('tools: Read, Edit, Write, Bash, Grep, Glob\n');
  });

  /** A tiny custom org that shares NOTHING with the starter templates. */
  function tinyHome(): string {
    const home = freshHomePath();
    const role = (id: string, over: Record<string, unknown>) => writeJson(path.join(home, 'org/roles', `${id}.json`), {
      id, title: id.toUpperCase(), description: `The ${id}.`, level: 1, dutiesPrompt: `Do ${id} work.`, tier: 'mid', maxTier: 'deep',
      nativeTools: ['Read'], gatewayTools: [], scope: {}, maxTurns: 7, maxRunUsd: 1, ...over,
    });
    const agent = (id: string, roleId: string, parentAgentId: string | null, over: Record<string, unknown> = {}) => writeJson(path.join(home, 'org/agents', `${id}.json`), {
      id, displayName: id, roleId, parentAgentId, departmentId: 'lab', namedAfterRealPerson: false, status: 'active', ...over,
    });
    role('lead', { nativeTools: ['Read', 'Agent'], tier: 'deep', description: 'Leads the lab.' });
    role('bench', { nativeTools: ['Read', 'Bash'], tier: 'cheap', level: 2 });
    agent('boss', 'lead', null);
    agent('tech-a', 'bench', 'boss');
    agent('tech-b', 'bench', 'boss', { status: 'paused' });
    writeJson(path.join(home, 'org/departments/lab.json'), { id: 'lab', name: 'Lab', directorAgentId: 'boss', autonomy: 'L1', dataClass: 'internal', goalIds: [], status: 'active' });
    writeJson(path.join(home, 'org/providers.json'), {
      providers: {
        alt: { adapter: 'fleet-loop', baseUrl: 'http://127.0.0.1:1/v1', tiers: { cheap: 'tiny' }, dataClasses: ['public'], privateEligible: true },
        main: { adapter: 'claude-code', auth: 'subscription', tiers: { cheap: 'c-model', deep: 'd-model' }, dataClasses: ['public'], privateEligible: true },
      },
      failover: {},
    });
    return home;
  }

  test('custom org: exact output, paused agents skipped, missing tier inherits', async () => {
    const { org, models } = await loadOrg(tinyHome());
    expect(models).toEqual({ cheap: 'c-model', deep: 'd-model' });
    const out = renderAll(org, models, common);
    expect(out.map((o) => o.file)).toEqual(['.claude/agents/boss.md', '.claude/agents/tech-a.md']);
    expect(out[0]!.text).toBe(
      ['---', 'name: boss', 'description: "Leads the lab."', 'model: d-model', 'tools: Read, Agent(tech-a)', 'maxTurns: 7', '---', GENERATED_MARKER, '# boss - LEAD', 'Do lead work.', '', 'COMMON RULES', ''].join('\n'),
    );
    expect(out[1]!.text).toBe(
      ['---', 'name: tech-a', 'description: "The bench."', 'model: c-model', 'tools: Read, Bash', 'maxTurns: 7', '---', GENERATED_MARKER, '# tech-a - BENCH', 'Do bench work.', '', 'COMMON RULES', ''].join('\n'),
    );
  });

  test('syncAgents writes, is idempotent, --check detects drift, removes only stale generated files', async () => {
    const home = tinyHome();
    const out = tmp();
    const cf = path.join(tmp(), 'common.md');
    fs.writeFileSync(cf, common);
    fs.mkdirSync(path.join(out, '.claude/agents'), { recursive: true });
    fs.writeFileSync(path.join(out, '.claude/agents/mine.md'), '---\nname: mine\n---\nhand written\n');
    fs.writeFileSync(path.join(out, '.claude/agents/old.md'), `---\nname: old\n---\n${GENERATED_MARKER}\nold\n`);
    const first = await syncAgents({ home, outDir: out, common: cf });
    expect(first).toEqual({ total: 2, changed: ['.claude/agents/boss.md', '.claude/agents/tech-a.md'], removed: ['.claude/agents/old.md'] });
    expect(fs.existsSync(path.join(out, '.claude/agents/mine.md'))).toBe(true);
    expect(fs.existsSync(path.join(out, '.claude/agents/old.md'))).toBe(false);
    expect(await syncAgents({ home, outDir: out, common: cf })).toEqual({ total: 2, changed: [], removed: [] });
    const logs: string[] = [];
    const io = { out: (s: string) => logs.push(s), err: (s: string) => logs.push(s) };
    expect(await main(['--home', home, '--out', out, '--common', cf, '--check'], io)).toBe(0);
    fs.appendFileSync(path.join(out, '.claude/agents/boss.md'), 'drift');
    expect(await main(['--home', home, '--out', out, '--common', cf, '--check'], io)).toBe(1);
    expect(await main(['--bogus'], io)).toBe(2);
    expect(await main(['--home', path.join(tmp(), 'missing'), '--out', out, '--common', cf], io)).toBe(0); // empty company: no agents
  });

  test('an agent whose role is missing fails loudly', async () => {
    const home = tinyHome();
    fs.rmSync(path.join(home, 'org/roles/bench.json'));
    await expect(loadOrg(home)).rejects.toThrow("role 'bench' does not exist");
  });
});

describe('company.example and the committed agents', () => {
  test('company.example equals a fresh import of the starter templates', async () => {
    expect(exampleTemplates()).toEqual(STARTER);
    const want = await buildExampleTree();
    const have = readTree(path.join(repoRoot, 'company.example'));
    expect(Object.keys(have)).toEqual(Object.keys(want));
    for (const k of Object.keys(want)) expect([k, have[k]]).toEqual([k, want[k]]);
  });

  test('ACCEPT: import the four templates into a fresh home -> sync -> .claude/agents == repo; company.example matches', async () => {
    const home = freshHomePath();
    const imp = await run(['import', 'org-full-life', 'defaults-v1', 'roles-content', 'roles-verification', '--home', home, '--apply']);
    expect(imp.code).toBe(0);
    const out = tmp();
    const r = await syncAgents({ home, outDir: out });
    expect(r.total).toBe(27);
    const gen = readTree(path.join(out, '.claude/agents'));
    const committed = readTree(path.join(repoRoot, '.claude/agents'));
    expect(gen).toEqual(committed);
    expect(readTree(home)).toEqual(readTree(path.join(repoRoot, 'company.example')));
  });

  test('no agent file for the removed CEO id, and the Owner is not an agent', () => {
    const files = fs.readdirSync(path.join(repoRoot, '.claude/agents'));
    expect(files).toContain('cos.md');
    expect(files).not.toContain('tej.md');
  });
});
