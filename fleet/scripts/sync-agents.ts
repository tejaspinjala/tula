#!/usr/bin/env bun
// Generates .claude/agents/*.md from fleet/org.json + providers.json.
//   bun fleet/scripts/sync-agents.ts          write files
//   bun fleet/scripts/sync-agents.ts --check  exit 1 if files are out of date (CI)
import fs from 'node:fs';
import { p, loadJSON, ensureDir } from '../lib/core.ts';

export function renderAgent(node, org, models, common) {
  const children = org.nodes.filter((n) => n.parent === node.id).map((n) => n.id);
  const tools = node.tools.map((t) => (t === 'Agent' ? (children.length ? `Agent(${children.join(', ')})` : null) : t)).filter(Boolean);
  const model = models[node.tier] || 'inherit';
  const fm = [
    '---',
    `name: ${node.id}`,
    `description: ${JSON.stringify(node.desc)}`,
    `model: ${model}`,
    `tools: ${tools.join(', ')}`,
    ...(node.maxTurns ? [`maxTurns: ${node.maxTurns}`] : []),
    '---',
  ].join('\n');
  const body = `# ${node.name} - ${node.title}\n${node.role}\n\n${common}`;
  return `${fm}\n${body}\n`;
}

export function renderAll() {
  const org = loadJSON('fleet/org.json');
  const prov = loadJSON('fleet/router/providers.json');
  const name = process.env.FLEET_PROVIDER || prov.active;
  const models = prov.providers[name];
  if (!models) throw new Error(`unknown provider "${name}"`);
  const common = fs.readFileSync(p('fleet', 'prompts', 'common.md'), 'utf8').trim();
  return org.nodes.map((n) => ({ file: p('.claude', 'agents', `${n.id}.md`), text: renderAgent(n, org, models, common) }));
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const out = renderAll();
  let stale = 0;
  if (!check) ensureDir(p('.claude', 'agents'));
  for (const { file, text } of out) {
    const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
    if (cur !== text) {
      stale++;
      if (!check) fs.writeFileSync(file, text);
    }
  }
  if (check && stale) { console.error(`${stale} agent file(s) out of date. Run: npm run sync`); process.exit(1); }
  console.log(check ? 'agents up to date' : `synced ${out.length} agents (${stale} changed)`);
}
