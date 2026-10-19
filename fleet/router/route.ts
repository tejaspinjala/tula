#!/usr/bin/env bun
// Deterministic task router. Costs zero tokens. Usage:
//   bun fleet/router/route.ts --task "wire the save button to POST /orders" [--files 3] [--risk high] [--failures 1]
import { loadJSON } from '../lib/core.ts';

const ORDER = ['cheap', 'mid', 'deep'];
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function loadCfg() {
  return {
    org: loadJSON('fleet/org.json'),
    routes: loadJSON('fleet/router/routes.json'),
    providers: loadJSON('fleet/router/providers.json'),
  };
}

export function route(task, opts = {}, cfg = loadCfg()) {
  const { files = 0, risk = 'low', failures = 0 } = opts;
  const text = String(task).toLowerCase();
  let best = null;
  let bestHits = 0;
  for (const r of cfg.routes.rules) {
    const hits = r.match.filter((k) => new RegExp('\\b' + esc(k)).test(text)).length;
    if (hits > bestHits) {
      best = r;
      bestHits = hits;
    }
  }
  const d = cfg.routes.defaults;
  const rule = best || { id: 'default', ...d };
  const employeeId = rule.employee || d.employee;
  const node = cfg.org.nodes.find((n) => n.id === employeeId);
  if (!node) throw new Error(`router: unknown employee "${employeeId}" in rule ${rule.id}`);

  const reasons = [bestHits ? `rule:${rule.id} (${bestHits} hit${bestHits > 1 ? 's' : ''})` : 'rule:default (no keyword hits)'];
  let idx = ORDER.indexOf(rule.tier || node.tier);
  const base = idx;
  if (risk === 'high') { idx++; reasons.push('risk=high +1 tier'); }
  if (files > cfg.routes.escalate.files) { idx++; reasons.push(`files>${cfg.routes.escalate.files} +1 tier`); }
  if (failures > 0) { idx += failures; reasons.push(`${failures} failed attempt(s) +${failures} tier`); }
  idx = Math.min(idx, ORDER.length - 1);
  const tier = ORDER[idx];

  const provName = process.env.FLEET_PROVIDER || cfg.providers.active;
  const model = cfg.providers.providers[provName]?.[tier] || 'inherit';
  return {
    rule: rule.id,
    employee: employeeId,
    tier,
    model,
    escalated: idx > base,
    skills: rule.skills ?? d.skills,
    maxTurns: rule.maxTurns ?? node.maxTurns ?? d.maxTurns,
    council: rule.id === 'council',
    reasons,
  };
}

if (import.meta.main) {
  const a = process.argv.slice(2);
  const get = (k, dflt) => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : dflt; };
  const task = get('task');
  if (!task) { console.error('usage: route.ts --task "<text>" [--files N] [--risk low|high] [--failures N]'); process.exit(2); }
  console.log(JSON.stringify(route(task, { files: +get('files', 0), risk: get('risk', 'low'), failures: +get('failures', 0) }), null, 2));
}
