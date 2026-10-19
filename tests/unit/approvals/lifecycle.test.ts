import { test, expect, beforeEach, afterEach } from 'bun:test';
import {
  request, approve, deny, reserve, consume, release, get, list, actionHash, approvalsDir,
  ApprovalError, DEFAULT_LEASE_MS,
} from '../../../engine/lib/approvals.ts';
import { approvalSchema } from '../../../engine/schema/approval.ts';
import { setup, H, HASH_A, HASH_B } from './helpers.ts';

let s: ReturnType<typeof setup>;
beforeEach(() => { s = setup(); });
afterEach(() => s.cleanup());

const ask = (hash = HASH_A, by = 'e-scribe') => request({ actionHash: hash, summary: 'npm publish', requestedBy: by }, s.opts());
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'ok';
  } catch (e) {
    return e instanceof ApprovalError ? e.code : String(e);
  }
};

test('happy path: request -> approve -> reserve -> consume; single use; derived state validates against the schema', async () => {
  const a = await ask();
  expect(a).toMatchObject({ status: 'pending', usesLeft: 1, approverRequired: 'owner', requestedBy: 'e-scribe', kind: 'external' });
  expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(72 * H);
  expect(await reserve(HASH_A, {}, s.opts())).toBeNull(); // pending is not authorised
  const ok = await approve(a.id, 'owner', s.opts());
  expect(ok).toMatchObject({ status: 'approved', decidedBy: 'owner' });
  const r = await reserve(HASH_A, { toolUseId: 'tu1' }, s.opts());
  expect(r).toMatchObject({ approvalId: a.id, actionHash: HASH_A, toolUseId: 'tu1' });
  expect((await get(a.id, s.opts()))?.approval.status).toBe('reserved');
  expect(await consume(r!.token, s.opts())).toBe(true);
  const after = (await get(a.id, s.opts()))!.approval;
  expect(after).toMatchObject({ status: 'consumed', usesLeft: 0 });
  expect(() => approvalSchema.parse(after)).not.toThrow();
  // single use
  expect(await reserve(HASH_A, {}, s.opts())).toBeNull();
  expect(await consume(r!.token, s.opts())).toBe(false);
  expect(await release(r!.token, undefined, s.opts())).toBe(false);
});

test('a failed action releases the reservation and the approval can be retried', async () => {
  const a = await ask();
  await approve(a.id, 'owner', s.opts());
  const r1 = await reserve(HASH_A, {}, s.opts());
  expect(await release(r1!.token, 'exit 1', s.opts())).toBe(true);
  expect((await get(a.id, s.opts()))?.approval).toMatchObject({ status: 'released', usesLeft: 1 });
  expect(await consume(r1!.token, s.opts())).toBe(false); // a released token is dead
  const r2 = await reserve(HASH_A, {}, s.opts());
  expect(r2).not.toBeNull();
  expect(r2!.token).not.toBe(r1!.token);
  expect(await consume(r2!.token, s.opts())).toBe(true);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('consumed');
});

test('expiry: a pending approval expires after 72h and can no longer be approved; an approved one stops authorising', async () => {
  const a = await ask();
  s.clock.advance(72 * H);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('expired');
  expect(await code(approve(a.id, 'owner', s.opts()))).toBe('expired');

  const b = await ask(HASH_B); // the expired one no longer blocks a fresh request for another hash
  await approve(b.id, 'owner', s.opts());
  s.clock.advance(72 * H - 1);
  expect((await get(b.id, s.opts()))?.approval.status).toBe('approved');
  s.clock.advance(1);
  expect((await get(b.id, s.opts()))?.approval.status).toBe('expired');
  expect(await reserve(HASH_B, {}, s.opts())).toBeNull();
  // a fresh request after expiry creates a new approval rather than returning the expired one
  const b2 = await ask(HASH_B);
  expect(b2.id).not.toBe(b.id);
});

test('custom ttl is honoured', async () => {
  const a = await request({ actionHash: HASH_A, summary: 'x', requestedBy: 'e-coder', ttlMs: H }, s.opts());
  expect(Date.parse(a.expiresAt) - Date.parse(a.createdAt)).toBe(H);
});

test('an unsettled reservation lapses back to approved after the lease; its late consume still settles it', async () => {
  const a = await ask();
  await approve(a.id, 'owner', s.opts());
  const r1 = await reserve(HASH_A, {}, s.opts());
  expect(await reserve(HASH_A, {}, s.opts())).toBeNull(); // live lease blocks a second use
  s.clock.advance(DEFAULT_LEASE_MS - 1);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('reserved');
  s.clock.advance(1);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('approved'); // crash: not burned, not leaked
  // nobody re-reserved: the late PostToolUse can still consume
  expect(await consume(r1!.token, s.opts())).toBe(true);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('consumed');
});

test('after a lapsed lease is re-reserved, the old token is dead', async () => {
  const a = await ask();
  await approve(a.id, 'owner', s.opts());
  const r1 = await reserve(HASH_A, {}, s.opts());
  s.clock.advance(DEFAULT_LEASE_MS);
  const r2 = await reserve(HASH_A, {}, s.opts());
  expect(r2).not.toBeNull();
  expect(await consume(r1!.token, s.opts())).toBe(false);
  expect(await release(r1!.token, undefined, s.opts())).toBe(false);
  expect(await consume(r2!.token, s.opts())).toBe(true);
});

test('a lease that lapses after the approval expired leaves it expired', async () => {
  const a = await ask();
  await approve(a.id, 'owner', s.opts());
  s.clock.advance(72 * H - 1000);
  await reserve(HASH_A, {}, s.opts());
  s.clock.advance(2000);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('reserved'); // in flight: let it settle
  s.clock.advance(DEFAULT_LEASE_MS);
  expect((await get(a.id, s.opts()))?.approval.status).toBe('expired');
  expect(await reserve(HASH_A, {}, s.opts())).toBeNull();
});

test('self-approval is impossible: decidedBy == requestedBy is rejected, and so is any non-owner decider', async () => {
  const a = await ask(HASH_A, 'e-scribe');
  expect(await code(approve(a.id, 'e-scribe', s.opts()))).toBe('self_approval');
  expect(await code(deny(a.id, 'e-scribe', undefined, s.opts()))).toBe('self_approval');
  expect(await code(approve(a.id, 'mgr-app', s.opts()))).toBe('wrong_approver');
  expect((await get(a.id, s.opts()))?.approval.status).toBe('pending');
  // an agent cannot request as 'owner' (which would let 'owner' be both sides)
  expect(await code(request({ actionHash: HASH_B, summary: 'x', requestedBy: 'owner' }, s.opts()))).toBe('bad_request');
  // the schema refuses decidedBy == requestedBy too
  expect(approvalSchema.safeParse({ ...a, status: 'approved', decidedBy: 'e-scribe', decidedAt: a.createdAt }).success).toBe(false);
});

test('deny is final', async () => {
  const a = await ask();
  expect((await deny(a.id, 'owner', 'no', s.opts())).status).toBe('denied');
  expect(await code(approve(a.id, 'owner', s.opts()))).toBe('not_pending');
  expect(await reserve(HASH_A, {}, s.opts())).toBeNull();
  expect(await code(approve('apr_00000000000000000000000000', 'owner', s.opts()))).toBe('not_found');
});

test('hash binding: an approval for one input does not authorise a different input', async () => {
  const h1 = actionHash('Bash', { command: 'npm publish' });
  const h2 = actionHash('Bash', { command: 'npm publish --tag evil' });
  expect(h1).toMatch(/^[a-f0-9]{64}$/);
  expect(h1).not.toBe(h2);
  // key order does not matter; nested keys are covered
  expect(actionHash('mcp__x__send', { a: 1, b: { c: 2, d: 3 } })).toBe(actionHash('mcp__x__send', { b: { d: 3, c: 2 }, a: 1 }));
  expect(actionHash('mcp__x__send', { b: { c: 2 } })).not.toBe(actionHash('mcp__x__send', { b: { c: 3 } }));
  expect(actionHash('Bash', { command: 'x' })).not.toBe(actionHash('mcp__x__send', { command: 'x' }));
  const a = await request({ actionHash: h1, summary: 'npm publish', requestedBy: 'e-scribe' }, s.opts());
  await approve(a.id, 'owner', s.opts());
  expect(await reserve(h2, {}, s.opts())).toBeNull();
  expect(await reserve(h1, {}, s.opts())).not.toBeNull();
});

test('duplicate requests for an open approval return the same record', async () => {
  const a = await ask();
  const b = await ask();
  expect(b.id).toBe(a.id);
  expect(await list(s.opts())).toHaveLength(1);
});

test('the approvals dir may not live inside the project tree', async () => {
  expect(() => approvalsDir({ dir: `${s.project}/engine/approvals` })).toThrow(/inside_project/);
  expect(approvalsDir({ dir: s.dir })).toBe(s.dir);
  // default location is $FLEET_HOME/approvals
  expect(approvalsDir()).toBe(s.dir);
});
