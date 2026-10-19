import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { repoRoot } from '../helpers.ts';

const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

test('package.json has scripts', () => {
  expect(Object.keys(pkg.scripts).length).toBeGreaterThan(0);
});

for (const [name, cmd] of Object.entries(pkg.scripts)) {
  test(`script "${name}" targets exist`, () => {
    const files = cmd.split(/\s+/).filter((w) => /^[\w./-]+\.(ts|js|mjs|json)$/.test(w));
    for (const f of files) expect(fs.existsSync(path.join(repoRoot, f)), `${name}: ${f}`).toBe(true);
  });
}

test('no script still points at the old fleet/ dir', () => {
  for (const cmd of Object.values(pkg.scripts)) expect(cmd).not.toMatch(/(^|\s)fleet\//);
});
