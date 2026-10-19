#!/usr/bin/env bun
// Deterministic task router. Costs zero tokens. Usage:
//   bun engine/router/route.ts --task "wire the save button to POST /orders" [--files 3] [--risk high] [--failures 1]
import { loadJSON } from '../lib/core.ts';
import type { Org, Providers, RouteRule, Routes, Tier } from '../lib/types.ts';

const ORDER: Tier[] = ['cheap', 'mid', 'deep'];
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export interface RouterCfg {
  org: Org;
  routes: Routes;
  providers: Providers;
}

export interface RouteOpts {
  files?: number;
  risk?: string;
  failures?: number;
}

export interface RouteResult {
  rule: string;
  employee: string;
  tier: Tier;
  model: string;
  escalated: boolean;
  skills: string[];
  maxTurns: number;
  council: boolean;
  reasons: string[];
}

export function loadCfg(): RouterCfg {
  return {
    org: loadJSON<Org>('engine/org.json'),
    routes: loadJSON<Routes>('engine/router/routes.json'),
    providers: loadJSON<Providers>('engine/router/providers.json'),
  };
}

export function route(task: string, opts: RouteOpts = {}, cfg: RouterCfg = loadCfg()): RouteResult {
  const { files = 0, risk = 'low', failures = 0 } = opts;
  const text = String(task).toLowerCase();
  let best: RouteRule | null = null;
  let bestHits = 0;
  for (const r of cfg.routes.rules) {
    const hits = r.match.filter((k) => new RegExp('\\b' + esc(k)).test(text)).length;
    if (hits > bestHits) {
      best = r;
      bestHits = hits;
    }
  }
  const d = cfg.routes.defaults;
  const rule: Partial<RouteRule> & { id: string } = best || { id: 'default', ...d };
  const employeeId: string = rule.employee || d.employee;
  const node = cfg.org.nodes.find((n) => n.id === employeeId);
  if (!node) throw new Error(`router: unknown employee "${employeeId}" in rule ${rule.id}`);

  const reasons = [bestHits ? `rule:${rule.id} (${bestHits} hit${bestHits > 1 ? 's' : ''})` : 'rule:default (no keyword hits)'];
  let idx = ORDER.indexOf(rule.tier || node.tier);
  const base = idx;
  if (risk === 'high') { idx++; reasons.push('risk=high +1 tier'); }
  if (files > cfg.routes.escalate.files) { idx++; reasons.push(`files>${cfg.routes.escalate.files} +1 tier`); }
  if (failures > 0) { idx += failures; reasons.push(`${failures} failed attempt(s) +${failures} tier`); }
  idx = Math.min(idx, ORDER.length - 1);
  const tier = ORDER[idx] as Tier;

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
  const get = (k: string, dflt?: string): string | undefined => { const i = a.indexOf('--' + k); return i >= 0 ? a[i + 1] : dflt; };
  const task = get('task');
  if (!task) { console.error('usage: route.ts --task "<text>" [--files N] [--risk low|high] [--failures N]'); process.exit(2); }
  console.log(JSON.stringify(route(task, { files: Number(get('files', '0')), risk: get('risk', 'low'), failures: Number(get('failures', '0')) }), null, 2));
}
