// Human-approval queue. Agents can only *request*; a human approves via CLI or dashboard.
import fs from 'node:fs';
import path from 'node:path';
import { p, ensureDir, sha, clip, appendEvent } from './core.ts';

const dir = (k) => p('fleet', 'approvals', k);

export function actionId(tool, input) {
  const canon = JSON.stringify(input, Object.keys(input || {}).sort());
  return sha(tool + '|' + canon);
}

export function isApproved(id) {
  const f = path.join(dir('approved'), id + '.json');
  if (!fs.existsSync(f)) return false;
  fs.unlinkSync(f); // one-time use: an approval authorises exactly one execution
  return true;
}

export function request({ id, tool, input, by }) {
  ensureDir(dir('pending'));
  const f = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(f)) {
    const rec = { id, tool, summary: clip(JSON.stringify(input), 400), by: by || 'unknown', ts: new Date().toISOString() };
    fs.writeFileSync(f, JSON.stringify(rec, null, 2));
    appendEvent({ event: 'approval_requested', id, tool, agent: by, text: rec.summary });
  }
}

export function list() {
  ensureDir(dir('pending'));
  return fs.readdirSync(dir('pending')).filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir('pending'), f), 'utf8')));
}

export function approve(id) {
  const src = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(src)) return false;
  ensureDir(dir('approved'));
  fs.renameSync(src, path.join(dir('approved'), id + '.json'));
  appendEvent({ event: 'approval_granted', id });
  return true;
}

export function deny(id) {
  const src = path.join(dir('pending'), id + '.json');
  if (!fs.existsSync(src)) return false;
  ensureDir(dir('denied'));
  fs.renameSync(src, path.join(dir('denied'), id + '.json'));
  appendEvent({ event: 'approval_denied', id });
  return true;
}
