import { test, expect, beforeAll, afterAll } from 'bun:test';
import fs from 'node:fs';
import { renderAll, renderAgent } from '../../engine/scripts/sync-agents.ts';
import { useRepoProject } from '../helpers.ts';

let restore: () => void;
beforeAll(() => { restore = useRepoProject(); });
afterAll(() => restore());

test('renderAll() matches the committed .claude/agents files (sync --check)', () => {
  const out = renderAll();
  expect(out.length).toBeGreaterThan(0);
  for (const { file, text } of out) {
    expect(fs.existsSync(file), `${file} missing; run: bun run sync`).toBe(true);
    expect(fs.readFileSync(file, 'utf8'), `${file} stale; run: bun run sync`).toBe(text);
  }
});

test('renderAgent expands Agent tool into children and drops it for leaves', () => {
  const org = {
    company: 't',
    nodes: [
      { id: 'boss', name: 'B', title: 'Boss', level: 0, tier: 'deep' as const, parent: null, desc: 'd', tools: ['Read', 'Agent'], role: 'r' },
      { id: 'w1', name: 'W', title: 'Worker', level: 1, tier: 'cheap' as const, parent: 'boss', desc: 'd', tools: ['Read', 'Agent'], role: 'r', maxTurns: 5 },
    ],
  };
  const models = { cheap: 'haiku', mid: 'sonnet', deep: 'opus' };
  const boss = renderAgent(org.nodes[0]!, org, models, 'COMMON');
  expect(boss).toContain('tools: Read, Agent(w1)');
  expect(boss).toContain('model: opus');
  const w = renderAgent(org.nodes[1]!, org, models, 'COMMON');
  expect(w).toContain('tools: Read\n');
  expect(w).toContain('maxTurns: 5');
  expect(w.endsWith('COMMON\n')).toBe(true);
});
