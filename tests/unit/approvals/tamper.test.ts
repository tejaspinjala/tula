import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { request, approve, reserve, consume, list, get, verifyLog, actionHash, ApprovalError, LOG_NAME, HEAD_NAME } from '../../../engine/lib/approvals.ts';
import { canonicalJson, entryHash } from '../../../engine/lib/chain.ts';
import { decide } from '../../../engine/hooks/security-gate.ts';
import { setup, HASH_A } from './helpers.ts';

let s: ReturnType<typeof setup>;
beforeEach(() => { s = setup(); });
afterEach(() => s.cleanup());

const logFile = () => path.join(s.dir, LOG_NAME);
const lines = () => fs.readFileSync(logFile(), 'utf8').split('\n').filter(Boolean);
const writeLines = (ls: string[]) => fs.writeFileSync(logFile(), ls.map((l) => l + '\n').join(''));
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
    return false;
  } catch (e) {
    return e instanceof ApprovalError && e.code === 'chain_invalid';
  }
};

async function consumedApproval() {
  const a = await request({ actionHash: HASH_A, summary: 'npm publish', requestedBy: 'e-scribe' }, s.opts());
  await approve(a.id, 'owner', s.opts());
  const r = await reserve(HASH_A, {}, s.opts());
  await consume(r!.token, s.opts());
  return a;
}

test('editing a payload in the middle of the chain is detected and everything fails closed', async () => {
  const a = await request({ actionHash: HASH_A, summary: 'npm publish', requestedBy: 'e-scribe' }, s.opts());
  await request({ actionHash: 'c'.repeat(64), summary: 'other', requestedBy: 'e-scribe' }, s.opts());
  // forge: flip the first request to already-approved by owner
  const ls = lines();
  const e = JSON.parse(ls[0]!);
  e.payload.approval.status = 'approved';
  e.payload.approval.decidedBy = 'owner';
  ls[0] = JSON.stringify(e);
  writeLines(ls);
  expect((await verifyLog(s.opts())).ok).toBe(false);
  expect(await refused(reserve(HASH_A, {}, s.opts()))).toBe(true);
  expect(await refused(list(s.opts()))).toBe(true);
  expect(await refused(approve(a.id, 'owner', s.opts()))).toBe(true);
  expect(await refused(request({ actionHash: 'd'.repeat(64), summary: 'x', requestedBy: 'e' }, s.opts()))).toBe(true);
});

test('rewriting the last line with a recomputed hash is caught by the recorded head', async () => {
  const a = await consumedApproval();
  const ls = lines();
  const last = JSON.parse(ls[ls.length - 1]!);
  expect(last.payload.type).toBe('consumed');
  // turn "consumed" into "released" so the approval would be reusable, with a valid hash
  last.payload = { v: 1, type: 'released', id: a.id, token: last.payload.token };
  last.hash = entryHash(last);
  ls[ls.length - 1] = canonicalJson(last);
  writeLines(ls);
  expect(await refused(reserve(HASH_A, {}, s.opts()))).toBe(true);
});

test('cutting the consume record off the end is detected (truncation vs recorded head)', async () => {
  await consumedApproval();
  writeLines(lines().slice(0, -1));
  expect(await refused(reserve(HASH_A, {}, s.opts()))).toBe(true);
});

test('deleting the head record of a multi-entry log is refused', async () => {
  await consumedApproval();
  fs.rmSync(path.join(s.dir, HEAD_NAME));
  expect(await refused(reserve(HASH_A, {}, s.opts()))).toBe(true);
});

test('a hand-written (not chain-valid) approval line is refused, not honoured', async () => {
  const a = await request({ actionHash: HASH_A, summary: 'npm publish', requestedBy: 'e-scribe' }, s.opts());
  fs.appendFileSync(logFile(), JSON.stringify({ type: 'decided', id: a.id, decision: 'approved', decidedBy: 'owner' }) + '\n');
  expect(await refused(reserve(HASH_A, {}, s.opts()))).toBe(true);
  // a torn forged line too
  writeLines(lines().slice(0, -1));
  fs.appendFileSync(logFile(), '{"seq":2,');
  expect(await refused(get(a.id, s.opts()))).toBe(true);
});

test('the gate denies external actions while the log is tampered (fail closed)', async () => {
  const input = { command: 'npm publish' };
  const a = await request({ actionHash: actionHash('Bash', input), summary: 'npm publish', requestedBy: 'e-scribe' }, s.opts());
  await approve(a.id, 'owner', s.opts());
  const ls = lines();
  ls[0] = ls[0]!.replace('npm publish', 'npm publisH');
  writeLines(ls);
  const r = await decide({ tool_name: 'Bash', tool_input: input, agent_type: 'e-scribe' });
  expect(r.decision).toBe('deny');
  expect(r.decision === 'deny' && r.reason).toContain('approvals are unavailable');
});

test('a forged file in the old engine/approvals/approved/ folder has no effect', async () => {
  const input = { command: 'npm publish' };
  const ev = { tool_name: 'Bash', tool_input: input, agent_type: 'e-scribe' };
  const first = await decide(ev);
  expect(first.decision).toBe('deny');
  // what the old isApproved() honoured: any file named after the action id
  const oldDir = path.join(s.project, 'engine', 'approvals', 'approved');
  fs.mkdirSync(oldDir, { recursive: true });
  const [{ approval }] = await list();
  for (const name of [approval!.id, actionHash('Bash', input), actionHash('Bash', input).slice(0, 12)]) {
    fs.writeFileSync(path.join(oldDir, `${name}.json`), JSON.stringify({ id: name, tool: 'Bash' }));
  }
  expect((await decide(ev)).decision).toBe('deny');
  expect(await reserve(actionHash('Bash', input))).toBeNull();
  expect((await get(approval!.id))?.approval.status).toBe('pending');
  // and a forged file dropped into the new approvals dir is ignored too (only the chain counts)
  fs.writeFileSync(path.join(s.dir, `${approval!.id}.json`), JSON.stringify({ ...approval, status: 'approved', decidedBy: 'owner' }));
  expect((await decide(ev)).decision).toBe('deny');
});
