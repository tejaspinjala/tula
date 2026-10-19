import { test, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { request, approve, reserve, consume, get } from '../../../engine/lib/approvals.ts';
import { setup, HASH_A } from './helpers.ts';

let s: ReturnType<typeof setup>;
beforeEach(() => { s = setup(); });
afterEach(() => s.cleanup());

const worker = path.join(import.meta.dir, 'fixtures', 'reserve-worker.ts');

async function approved() {
  const a = await request({ actionHash: HASH_A, summary: 'npm publish', requestedBy: 'e-scribe' }, { dir: s.dir });
  await approve(a.id, 'owner', { dir: s.dir });
  return a;
}

test('double reserve in one process (Promise.all): exactly one wins', async () => {
  const a = await approved();
  const results = await Promise.all(Array.from({ length: 12 }, () => reserve(HASH_A, {}, { dir: s.dir, lock: { timeoutMs: 30_000 } })));
  const winners = results.filter((r) => r !== null);
  expect(winners).toHaveLength(1);
  expect((await get(a.id, { dir: s.dir }))?.approval.status).toBe('reserved');
  // and two concurrent consumes of the winning token settle it once
  const c = await Promise.all([consume(winners[0]!.token, { dir: s.dir }), consume(winners[0]!.token, { dir: s.dir })]);
  expect(c.filter(Boolean)).toHaveLength(1);
});

test('double reserve across 6 processes: exactly one wins', async () => {
  const a = await approved();
  const go = path.join(s.home, 'go');
  const n = 6;
  const procs = Array.from({ length: n }, () =>
    Bun.spawn([process.execPath, worker, s.dir, HASH_A, go], { stdout: 'pipe', stderr: 'pipe', env: process.env }));
  const until = Date.now() + 60_000;
  while (fs.readdirSync(s.home).filter((f) => f.startsWith('go.ready.')).length < n && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 10));
  }
  fs.writeFileSync(go, 'go');
  const out = await Promise.all(procs.map(async (p) => ({
    code: await p.exited,
    out: await new Response(p.stdout).text(),
    err: await new Response(p.stderr).text(),
  })));
  for (const o of out) expect(o.code, o.err).toBe(0);
  const tokens = out.map((o) => (JSON.parse(o.out) as { token: string | null }).token).filter((t) => t !== null);
  expect(tokens).toHaveLength(1);
  const st = await get(a.id, { dir: s.dir });
  expect(st?.approval.status).toBe('reserved');
  expect(st?.reservation?.token).toBe(tokens[0]!);
}, 90_000);
