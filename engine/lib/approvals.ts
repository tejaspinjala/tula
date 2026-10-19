// Human-approval queue. Agents can only *request*; a human approves via CLI or dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { p, ensureDir, sha, clip, appendEvent } from './core.ts';

export interface ApprovalRecord {
  id: string;
  tool: string;
  summary: string;
  by: string;
  ts: string;
}

const dir = (k: 'pending' | 'approved' | 'denied') => p('engine', 'approvals', k);

export function actionId(tool: string, input: Record<string, unknown> | undefined): string {
  const canon = JSON.stringify(input, Object.keys(input || {}).sort());
  return sha(tool + '|' + canon);
}

export function isApproved(id: string): boolean {
  const f = path.join(dir('approved'), id + '.json');
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); // one-time use: an approval authorises exactly one execution
  return true;
}

export function request({ id, tool, input, by }: { id: string; tool: string; input: unknown; by?: string }): void {
  ensureDir(dir('pending'));
  const f = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(f)) {
    const rec: ApprovalRecord = { id, tool, summary: clip(JSON.stringify(input), 400), by: by || 'unknown', ts: new Date().toISOString() };
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
    appendEvent({ event: 'approval_requested', id, tool, agent: by, text: rec.summary });
  }
}

export function list(): ApprovalRecord[] {
  ensureDir(dir('pending'));
  return fs.readdirSync(dir('pending')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir('pending'), f), 'utf8')));
}

export function approve(id: string): boolean {
  const src = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(src)) return false;
  ensureDir(dir('approved'));
  fs.renameSync(src, path.join(dir('approved'), id + '.json'));
  appendEvent({ event: 'approval_granted', id });
  return true;
}

export function deny(id: string): boolean {
  const src = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(src)) return false;
  ensureDir(dir('denied'));
  fs.renameSync(src, path.join(dir('denied'), id + '.json'));
  appendEvent({ event: 'approval_denied', id });
  return true;
}
