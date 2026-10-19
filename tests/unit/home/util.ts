import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { initHome } from '../../../engine/home/home.ts';
import type { Runner } from '../../../engine/home/run.ts';

export function tmpHome(): { home: string; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-home-test-'));
  const home = path.join(base, 'fleet');
  return { home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export function initedHome() {
  const t = tmpHome();
  const r = initHome({ home: t.home });
  return { ...t, home: r.home };
}

export function writeJson(file: string, v: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(v, null, 2));
}

export const COMPANY = { name: 'Acme', ownerName: 'Pat', currency: 'USD', timezone: 'UTC', moneyMode: 'paper', autonomyMax: 'L1' };
export const DEPT = { id: 'ops', name: 'Ops', directorAgentId: 'dir-ops', autonomy: 'L1', dataClass: 'internal', goalIds: [], status: 'active' };

export function provider(over: Record<string, unknown> = {}) {
  return { adapter: 'fleet-loop', baseUrl: 'https://example.com/v1', tiers: {}, dataClasses: ['public'], privateEligible: false, ...over };
}
export const providersFile = (providers: Record<string, unknown>) => ({ providers, failover: {} });

/** A fake runner: map "cmd arg arg" prefix -> result; anything else is "missing". */
export function fakeRunner(table: Record<string, Partial<{ code: number; stdout: string; stderr: string }>>): Runner {
  return (cmd, args) => {
    const key = [cmd, ...args].join(' ');
    const hit = Object.keys(table).find((k) => key.startsWith(k));
    if (!hit) return { code: 127, stdout: '', stderr: 'not found', missing: true };
    return { code: 0, stdout: '', stderr: '', ...table[hit] };
  };
}
