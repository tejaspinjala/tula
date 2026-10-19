import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { appendEvent, encodeEventLine, MAX_EVENT_BYTES, eventsFile } from '../../../engine/lib/core.ts';
import { deriveLinks, deriveCtx, parseEvents, ctxKey } from '../../../engine/lib/derive.ts';
import { writeSnapshots } from '../../../engine/lib/snapshot.ts';
import { useTempProject, repoRoot } from '../../helpers.ts';

let tmp: ReturnType<typeof useTempProject>;
beforeEach(() => { tmp = useTempProject(); });
afterEach(() => tmp.restore());

const hook = (name: string) => path.join(repoRoot, 'engine', 'hooks', name);
async function runHook(name: string, input: unknown, dir = tmp.dir) {
  const proc = Bun.spawn([process.execPath, hook(name)], {
    stdin: new Blob([JSON.stringify(input)]), stdout: 'pipe', stderr: 'pipe',
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
  });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { out, err, code };
}
const lines = () => fs.readFileSync(eventsFile(), 'utf8').split('\n').filter(Boolean);

describe('event-log hook under concurrency', () => {
  test('50 concurrent hook processes append exactly 50 well-formed, non-interleaved lines', async () => {
    const runs = await Promise.all(Array.from({ length: 50 }, (_, i) =>
      runHook('event-log.ts', { hook_event_name: 'PreToolUse', session_id: 's1', tool_name: 'Bash', agent_type: 'e-coder', agent_id: `a${i}`, tool_input: { command: `echo ${i} ${'x'.repeat(120)}` } })));
    for (const r of runs) { expect(r.code).toBe(0); expect(r.out).toBe(''); }
    const ls = lines();
    expect(ls).toHaveLength(50);
    const seen = new Set<string>();
    for (const l of ls) {
      expect(Buffer.byteLength(l) + 1).toBeLessThanOrEqual(MAX_EVENT_BYTES);
      const o = JSON.parse(l);
      expect(o).toMatchObject({ event: 'tool', agent: 'e-coder', session: 's1' });
      seen.add(String(o.text));
    }
    expect(seen.size).toBe(50);
    // no shared RMW state files were created
    expect(fs.existsSync(path.join(tmp.dir, 'engine', 'state', 'links.json'))).toBe(false);
    expect(fs.existsSync(path.join(tmp.dir, 'engine', 'state', 'ctx.json'))).toBe(false);
  }, 60_000);

  test('parallel same-type spawns through the real hook link to the right parents', async () => {
    const s = 'sess';
    // two managers (p1, p2) delegate to e-coder; children start in the opposite order
    await runHook('event-log.ts', { hook_event_name: 'SubagentStart', session_id: s, agent_type: 'mgr-a', agent_id: 'p1' });
    await runHook('event-log.ts', { hook_event_name: 'SubagentStart', session_id: s, agent_type: 'mgr-b', agent_id: 'p2' });
    await Promise.all([
      runHook('event-log.ts', { hook_event_name: 'PreToolUse', session_id: s, tool_name: 'Agent', agent_type: 'mgr-a', agent_id: 'p1', tool_input: { subagent_type: 'e-coder', prompt: 'A' } }),
      runHook('event-log.ts', { hook_event_name: 'PreToolUse', session_id: s, tool_name: 'Agent', agent_type: 'mgr-b', agent_id: 'p2', tool_input: { subagent_type: 'e-coder', prompt: 'B' } }),
    ]);
    await runHook('event-log.ts', { hook_event_name: 'SubagentStart', session_id: s, agent_type: 'e-coder', agent_id: 'c2', parent_agent_id: 'p2' });
    await runHook('event-log.ts', { hook_event_name: 'SubagentStart', session_id: s, agent_type: 'e-coder', agent_id: 'c1', parent_agent_id: 'p1' });
    await runHook('event-log.ts', { hook_event_name: 'SubagentStop', session_id: s, agent_type: 'e-coder', agent_id: 'c1', last_assistant_message: 'done A' });
    const events = parseEvents(fs.readFileSync(eventsFile(), 'utf8'));
    const l = deriveLinks(events);
    expect(l.parents.c1).toBe('mgr-a');
    expect(l.parents.c2).toBe('mgr-b');
    const report = events.find((e) => e.kind === 'report' && e.agent_id === 'c1');
    expect(report).toMatchObject({ from: 'e-coder', to: 'mgr-a' });
    const spawnC2 = events.find((e) => e.event === 'spawn' && e.agent_id === 'c2');
    expect(spawnC2).toMatchObject({ parent: 'mgr-b', parent_agent_id: 'p2' });
  }, 60_000);

  test('a garbage stdin and an unwritable state dir fail open (exit 0)', async () => {
    const proc = Bun.spawn([process.execPath, hook('event-log.ts')], { stdin: new Blob(['{{not json']), stdout: 'pipe', stderr: 'pipe', env: { ...process.env, CLAUDE_PROJECT_DIR: tmp.dir } });
    expect(await proc.exited).toBe(0);
    fs.writeFileSync(path.join(tmp.dir, 'engine'), 'a file where the dir should be');
    const r = await runHook('event-log.ts', { hook_event_name: 'Stop', last_assistant_message: 'x' });
    expect(r.code).toBe(0);
  });
});

describe('oversized events', () => {
  test('are truncated into one line, never split', () => {
    const line = encodeEventLine({ ts: 't', event: 'msg', kind: 'report', text: 'é'.repeat(20_000), other: 'y'.repeat(9000) });
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(line.endsWith('\n')).toBe(true);
    expect(line.indexOf('\n')).toBe(line.length - 1);
    const o = JSON.parse(line);
    expect(o).toMatchObject({ event: 'msg', kind: 'report', truncated: true });
    expect(o.text.endsWith('…')).toBe(true);
  });
  test('small events are untouched and not flagged', () => {
    const o = JSON.parse(encodeEventLine({ event: 'tool', text: 'hi' }));
    expect(o).toEqual({ event: 'tool', text: 'hi' });
  });
  test('a non-string blob falls back to routing fields only', () => {
    const o = JSON.parse(encodeEventLine({ event: 'tool', agent: 'a', blob: Array.from({ length: 5000 }, (_, i) => i) }));
    expect(o).toEqual({ truncated: true, event: 'tool', agent: 'a' });
  });
  test('appendEvent writes oversized input as exactly one line, and fails open on error', () => {
    expect(appendEvent({ event: 'x', text: 'z'.repeat(50_000) })).toBe(true);
    expect(appendEvent({ event: 'y' })).toBe(true);
    const ls = lines();
    expect(ls).toHaveLength(2);
    expect(JSON.parse(ls[0]!).truncated).toBe(true);
    fs.rmSync(path.join(tmp.dir, 'engine'), { recursive: true });
    fs.writeFileSync(path.join(tmp.dir, 'engine'), 'file');
    expect(appendEvent({ event: 'z' })).toBe(false);
  });
});

describe('context-guard hook', () => {
  const transcript = (tokens: number) => {
    const f = path.join(tmp.dir, `t${tokens}.jsonl`);
    fs.writeFileSync(f, JSON.stringify({ type: 'assistant', message: { role: 'assistant', usage: { input_tokens: tokens } } }) + '\n');
    return f;
  };
  const input = (tokens: number) => ({ hook_event_name: 'PostToolUse', session_id: 's1', agent_type: 'e-coder', agent_id: 'a1', transcript_path: transcript(tokens) });

  test('warns at 30% once, limits at 35%, records ctx events, writes no ctx.json', async () => {
    const env = process.env.FLEET_CONTEXT_WINDOW; delete process.env.FLEET_CONTEXT_WINDOW;
    try {
      expect((await runHook('context-guard.ts', input(20_000))).out).toBe('');
      const warn = await runHook('context-guard.ts', input(60_000));
      expect(JSON.parse(warn.out).hookSpecificOutput.additionalContext).toContain('Nearing the 35% limit');
      expect((await runHook('context-guard.ts', input(61_000))).out).toBe(''); // no repeat at same level
      const hard = await runHook('context-guard.ts', input(70_000));
      expect(JSON.parse(hard.out).hookSpecificOutput.additionalContext).toContain('LIMIT (35%)');
      const c = deriveCtx(parseEvents(fs.readFileSync(eventsFile(), 'utf8')));
      expect(c[ctxKey('s1', 'a1')]).toMatchObject({ pct: 35, level: 2, agent: 'e-coder' });
      expect(fs.existsSync(path.join(tmp.dir, 'engine', 'state', 'ctx.json'))).toBe(false);
    } finally { if (env !== undefined) process.env.FLEET_CONTEXT_WINDOW = env; }
  }, 60_000);

  test('50 concurrent guards leave only whole ctx lines', async () => {
    await Promise.all(Array.from({ length: 50 }, () => runHook('context-guard.ts', input(70_000))));
    const ls = lines();
    expect(ls.length).toBeGreaterThanOrEqual(1);
    for (const l of ls) expect(JSON.parse(l).event).toBe('ctx');
  }, 60_000);
});

describe('snapshots via the locked store', () => {
  test('writeSnapshots persists derived links and ctx', async () => {
    const dir = path.join(tmp.dir, 'engine', 'state');
    appendEvent({ event: 'spawn', agent: 'm', agent_id: 'p1', session: 's' });
    appendEvent({ event: 'spawn', agent: 'e', agent_id: 'c1', parent_agent_id: 'p1', session: 's' });
    appendEvent({ event: 'ctx', session: 's', agent_id: 'c1', pct: 40 });
    await Promise.all([writeSnapshots(dir), writeSnapshots(dir)]);
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'links.json'), 'utf8')).parents).toEqual({ p1: 'tej', c1: 'm' });
    expect(Object.values(JSON.parse(fs.readFileSync(path.join(dir, 'ctx.json'), 'utf8')))[0]).toMatchObject({ pct: 40, level: 2 });
  });
});
