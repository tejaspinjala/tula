import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { forbiddenIds, matcherFor, scan } from '../../../scripts/no-hardcode.ts';
import { repoRoot } from '../../helpers.ts';
import { cleanupTmp, tmp } from './util.ts';

afterEach(cleanupTmp);

describe('scripts/no-hardcode.ts', () => {
  test('the repo is clean', () => {
    expect(scan(repoRoot)).toEqual([]);
  });

  test('the forbidden list is derived from the shipped templates', () => {
    const ids = forbiddenIds(path.join(repoRoot, 'engine/templates'));
    for (const id of ['org-full-life', 'defaults-v1', 'roles-content', 'cos', 'e-coder', 'dir-eng', 'writer', 'engineering', 'apps']) expect(ids.has(id)).toBe(true);
    expect(ids.has('claude-max')).toBe(false); // a provider key, not an object id
  });

  /** A copy of the lint's world: the real templates + one engine file we control. */
  function world(code: string, rel = 'engine/lib/planted.ts'): string {
    const root = tmp();
    fs.cpSync(path.join(repoRoot, 'engine/templates'), path.join(root, 'engine/templates'), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), code);
    return root;
  }

  test('catches a planted dashed id (agent, template) anywhere in the line', () => {
    const v = scan(world("// route to e-coder\nconst t = 'org-full-life';\n"));
    expect(v.map((x) => [x.line, x.id])).toEqual([[1, 'e-coder'], [2, 'org-full-life']]);
    expect(v[0]!.file).toBe(path.join('engine', 'lib', 'planted.ts'));
  });

  test('catches a planted single-word role id only as a quoted literal', () => {
    expect(scan(world("if (role === 'writer') {}\n")).map((x) => x.id)).toEqual(['writer']);
    expect(scan(world('const writer = 1; // the writer\n'))).toEqual([]);
  });

  test('catches a planted id in a shell script and a script, but not in tests, docs or templates', () => {
    expect(scan(world('echo dir-eng\n', 'engine/bin/x.sh')).length).toBe(1);
    expect(scan(world("export const x = 'cos';\n", 'scripts/y.ts')).length).toBe(1);
    expect(scan(world("'e-coder'", 'tests/unit/x.test.ts'))).toEqual([]);
    expect(scan(world('e-coder', 'docs/x.md'))).toEqual([]);
    expect(scan(world('e-coder', 'engine/templates/org-full-life/note.ts'))).toEqual([]);
  });

  test('the opt-out marker silences one line', () => {
    expect(scan(world("const a = 'cos'; // no-hardcode-ok: layout\nconst b = 'cos';\n")).map((x) => x.line)).toEqual([2]);
  });

  test('schema vocabulary files may use single-word ids but not dashed ones', () => {
    expect(scan(world("export const K = ['judge', 'video'];\n", 'engine/schema/x.ts'))).toEqual([]);
    expect(scan(world("export const K = 'e-coder';\n", 'engine/schema/x.ts')).length).toBe(1);
  });

  test('the CLI exits 1 on a violation and 0 when clean', () => {
    const run = (root: string) => Bun.spawnSync(['bun', path.join(repoRoot, 'scripts/no-hardcode.ts'), '--root', root], { stdout: 'pipe', stderr: 'pipe' });
    const bad = run(world("const a = 'dir-sec';\n"));
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("hard-coded id 'dir-sec'");
    expect(run(world('const a = 1;\n')).exitCode).toBe(0);
    expect(run(repoRoot).exitCode).toBe(0);
  });

  test('matcherFor boundaries', () => {
    expect(matcherFor('e-coder').test('e-coder-2')).toBe(false);
    expect(matcherFor('e-coder').test('x e-coder.')).toBe(true);
    expect(matcherFor('cos').test('`cos`')).toBe(true);
    expect(matcherFor('cos').test('cosine')).toBe(false);
  });
});
