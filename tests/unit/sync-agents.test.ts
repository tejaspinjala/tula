import { test, expect } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { renderAgent, syncAgents } from '../../engine/adapters/claude-code/generate.ts';
import { repoRoot } from '../helpers.ts';

test('sync --check: the committed .claude/agents match what company.example generates', async () => {
  const r = await syncAgents({ home: path.join(repoRoot, 'company.example'), outDir: repoRoot, check: true });
  expect(r.total).toBeGreaterThan(0);
  expect(r.changed, 'stale files; run: bun run sync').toEqual([]);
  expect(r.removed, 'stale generated files; run: bun run sync').toEqual([]);
  for (const f of fs.readdirSync(path.join(repoRoot, '.claude/agents'))) expect(f.endsWith('.md')).toBe(true);
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
